import { plaidClient } from "./client.js";
import type BetterSqlite3 from "libsql";
type Database = BetterSqlite3.Database;
import { getCountryCodes } from "./link.js";
import type { RemovedTransaction, Transaction, TransactionStream } from "plaid";

/** Check if a Plaid API error is "product not supported/enabled" — safe to ignore */
export function isProductNotSupported(err: unknown): boolean {
  const data = (err as any)?.response?.data;
  if (!data?.error_code) return false;
  return [
    "PRODUCTS_NOT_SUPPORTED",
    "PRODUCT_NOT_READY",
    "PRODUCTS_NOT_ENABLED",
    "NO_ACCOUNTS",
    "PRODUCT_NOT_AVAILABLE",
    "INVALID_PRODUCT",
    "UNAUTHORIZED_PRODUCT",
  ].includes(data.error_code);
}

/** Refresh the stored products list and fetch logo if missing */
export async function refreshProducts(
  db: Database,
  itemId: string,
  accessToken: string
): Promise<string[]> {
  const resp = await plaidClient.itemGet({ access_token: accessToken });
  const products = resp.data.item.products || [];
  db.prepare(`UPDATE institutions SET products = ? WHERE item_id = ?`).run(
    JSON.stringify(products),
    itemId
  );

  // Fetch logo + primary_color if not already stored
  const inst = db.prepare(`SELECT logo FROM institutions WHERE item_id = ?`).get(itemId) as { logo: string | null } | undefined;
  if (!inst?.logo && resp.data.item.institution_id) {
    try {
      const { data } = await plaidClient.institutionsGetById({
        institution_id: resp.data.item.institution_id,
        country_codes: getCountryCodes(),
        options: { include_optional_metadata: true },
      });
      db.prepare(`UPDATE institutions SET logo = ?, primary_color = ? WHERE item_id = ?`)
        .run(data.institution.logo || null, data.institution.primary_color || null, itemId);
    } catch {}
  }

  return products;
}

/** Sync transactions for an institution using Plaid's sync endpoint */
export async function syncTransactions(
  db: Database,
  itemId: string,
  accessToken: string,
  cursor: string | null
) {
  let hasMore = true;
  let nextCursor = cursor || undefined;
  let added: Transaction[] = [];
  let modified: Transaction[] = [];
  let removed: RemovedTransaction[] = [];

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
    });
    added = added.concat(resp.data.added);
    modified = modified.concat(resp.data.modified);
    removed = removed.concat(resp.data.removed);
    hasMore = resp.data.has_more;
    nextCursor = resp.data.next_cursor;
  }

  const upsertTx = db.prepare(`
    INSERT INTO transactions (transaction_id, account_id, amount, date, name, merchant_name, category, subcategory, pending, iso_currency_code, payment_channel, logo_url, website)
    VALUES (@transaction_id, @account_id, @amount, @date, @name, @merchant_name, @category, @subcategory, @pending, @iso_currency_code, @payment_channel, @logo_url, @website)
    ON CONFLICT(transaction_id) DO UPDATE SET
      amount=excluded.amount, date=excluded.date, name=excluded.name,
      merchant_name=excluded.merchant_name, category=excluded.category,
      subcategory=excluded.subcategory, pending=excluded.pending,
      payment_channel=excluded.payment_channel, logo_url=excluded.logo_url,
      website=excluded.website
  `);

  const deleteTx = db.prepare(
    `DELETE FROM transactions WHERE transaction_id = ?`
  );

  const insertMany = db.transaction(() => {
    for (const t of [...added, ...modified]) {
      const cats = t.personal_finance_category;
      upsertTx.run({
        transaction_id: t.transaction_id,
        account_id: t.account_id,
        amount: t.amount,
        date: t.date,
        name: t.name,
        merchant_name: t.merchant_name || null,
        category: cats?.primary || null,
        subcategory: cats?.detailed || null,
        pending: t.pending ? 1 : 0,
        iso_currency_code: t.iso_currency_code || "USD",
        payment_channel: t.payment_channel || null,
        logo_url: t.logo_url || null,
        website: t.website || null,
      });
    }
    for (const r of removed) {
      deleteTx.run(r.transaction_id);
    }
  });
  insertMany();

  // Update cursor
  db.prepare(`UPDATE institutions SET cursor = ? WHERE item_id = ?`).run(
    nextCursor,
    itemId
  );

  return { added: added.length, modified: modified.length, removed: removed.length };
}

/** Sync account balances */
export async function syncBalances(db: Database, accessToken: string) {
  const resp = await plaidClient.accountsGet({ access_token: accessToken });

  const upsert = db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, official_name, type, subtype, mask, current_balance, available_balance, balance_limit, currency, updated_at)
    VALUES (@account_id, @item_id, @name, @official_name, @type, @subtype, @mask, @current_balance, @available_balance, @balance_limit, @currency, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET
      name=excluded.name, official_name=excluded.official_name,
      current_balance=excluded.current_balance, available_balance=excluded.available_balance,
      balance_limit=excluded.balance_limit, hidden=0, updated_at=datetime('now')
  `);

  const itemId = resp.data.item.item_id;
  const insertMany = db.transaction(() => {
    for (const a of resp.data.accounts) {
      upsert.run({
        account_id: a.account_id,
        item_id: itemId,
        name: a.name,
        official_name: a.official_name || null,
        type: a.type,
        subtype: a.subtype || null,
        mask: a.mask || null,
        current_balance: a.balances.current,
        available_balance: a.balances.available,
        balance_limit: a.balances.limit ?? null,
        currency: a.balances.iso_currency_code || "USD",
      });
    }

    const activeIds = resp.data.accounts.map(a => a.account_id);
    const staleAccounts = activeIds.length > 0
      ? db.prepare(`SELECT account_id FROM accounts WHERE item_id = ? AND account_id NOT IN (${activeIds.map(() => "?").join(",")})`).all(itemId, ...activeIds) as { account_id: string }[]
      : db.prepare(`SELECT account_id FROM accounts WHERE item_id = ?`).all(itemId) as { account_id: string }[];

    for (const account of staleAccounts) {
      db.prepare(`DELETE FROM transactions WHERE account_id = ?`).run(account.account_id);
      db.prepare(`DELETE FROM holdings WHERE account_id = ?`).run(account.account_id);
      db.prepare(`DELETE FROM investment_transactions WHERE account_id = ?`).run(account.account_id);
      db.prepare(`DELETE FROM liabilities WHERE account_id = ?`).run(account.account_id);
      db.prepare(`DELETE FROM recurring WHERE account_id = ?`).run(account.account_id);
      db.prepare(`DELETE FROM accounts WHERE account_id = ?`).run(account.account_id);
    }
  });
  insertMany();

  return resp.data.accounts.length;
}

/** Sync investment holdings + securities */
export async function syncInvestments(db: Database, accessToken: string) {
  const resp = await plaidClient.investmentsHoldingsGet({
    access_token: accessToken,
  });

  const upsertSecurity = db.prepare(`
    INSERT INTO securities (security_id, ticker, name, type, close_price, close_price_as_of)
    VALUES (@security_id, @ticker, @name, @type, @close_price, @close_price_as_of)
    ON CONFLICT(security_id) DO UPDATE SET
      close_price=excluded.close_price, close_price_as_of=excluded.close_price_as_of
  `);

  const upsertHolding = db.prepare(`
    INSERT INTO holdings (account_id, security_id, quantity, cost_basis, value, price, price_as_of, vested_value, vested_quantity, updated_at)
    VALUES (@account_id, @security_id, @quantity, @cost_basis, @value, @price, @price_as_of, @vested_value, @vested_quantity, datetime('now'))
    ON CONFLICT(account_id, security_id) DO UPDATE SET
      quantity=excluded.quantity, cost_basis=excluded.cost_basis,
      value=excluded.value, price=excluded.price,
      price_as_of=excluded.price_as_of, vested_value=excluded.vested_value,
      vested_quantity=excluded.vested_quantity, updated_at=datetime('now')
  `);

  const insertMany = db.transaction(() => {
    for (const s of resp.data.securities) {
      upsertSecurity.run({
        security_id: s.security_id,
        ticker: s.ticker_symbol || null,
        name: s.name || "Unknown",
        type: s.type || null,
        close_price: s.close_price || null,
        close_price_as_of: s.close_price_as_of || null,
      });
    }
    for (const h of resp.data.holdings) {
      upsertHolding.run({
        account_id: h.account_id,
        security_id: h.security_id,
        quantity: h.quantity,
        cost_basis: h.cost_basis || null,
        value: h.institution_value,
        price: h.institution_price,
        price_as_of: h.institution_price_as_of || null,
        vested_value: h.vested_value ?? null,
        vested_quantity: h.vested_quantity ?? null,
      });
    }
  });
  insertMany();

  return { securities: resp.data.securities.length, holdings: resp.data.holdings.length };
}

/** Sync recurring transaction streams from Plaid */
export async function syncRecurring(db: Database, accessToken: string) {
  const resp = await plaidClient.transactionsRecurringGet({
    access_token: accessToken,
  });

  const upsert = db.prepare(`
    INSERT INTO recurring (stream_id, account_id, merchant_name, description, frequency, category, subcategory, avg_amount, last_amount, first_date, last_date, is_active, status, stream_type, updated_at)
    VALUES (@stream_id, @account_id, @merchant_name, @description, @frequency, @category, @subcategory, @avg_amount, @last_amount, @first_date, @last_date, @is_active, @status, @stream_type, datetime('now'))
    ON CONFLICT(stream_id) DO UPDATE SET
      merchant_name=excluded.merchant_name, description=excluded.description,
      avg_amount=excluded.avg_amount, last_amount=excluded.last_amount,
      first_date=excluded.first_date, last_date=excluded.last_date,
      is_active=excluded.is_active, status=excluded.status,
      frequency=excluded.frequency, category=excluded.category,
      subcategory=excluded.subcategory, stream_type=excluded.stream_type,
      updated_at=datetime('now')
  `);

  const mapStream = (s: TransactionStream, type: "inflow" | "outflow") => ({
    stream_id: s.stream_id,
    account_id: s.account_id,
    merchant_name: s.merchant_name || null,
    description: s.description,
    frequency: s.frequency,
    category: s.personal_finance_category?.primary || null,
    subcategory: s.personal_finance_category?.detailed || null,
    avg_amount: s.average_amount.amount || 0,
    last_amount: s.last_amount.amount || 0,
    first_date: s.first_date,
    last_date: s.last_date,
    is_active: s.is_active ? 1 : 0,
    status: s.status,
    stream_type: type,
  });

  // Collect account_ids covered by this response
  const allStreams = [...resp.data.outflow_streams, ...resp.data.inflow_streams];
  const accountIds = [...new Set(allStreams.map(s => s.account_id))];

  const deactivate = db.prepare(
    `UPDATE recurring SET is_active = 0, updated_at = datetime('now') WHERE account_id = ?`
  );

  const insertMany = db.transaction(() => {
    // Mark existing streams inactive; upsert will re-activate current ones
    for (const aid of accountIds) deactivate.run(aid);
    for (const s of resp.data.outflow_streams) upsert.run(mapStream(s, "outflow"));
    for (const s of resp.data.inflow_streams) upsert.run(mapStream(s, "inflow"));
  });
  insertMany();

  return {
    outflows: resp.data.outflow_streams.length,
    inflows: resp.data.inflow_streams.length,
  };
}

/** Sync investment transactions (buy/sell/dividend history) */
export async function syncInvestmentTransactions(db: Database, accessToken: string) {
  const now = new Date();
  const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  let offset = 0;
  const count = 500;
  let totalFetched = 0;

  const upsertSecurity = db.prepare(`
    INSERT INTO securities (security_id, ticker, name, type, close_price, close_price_as_of)
    VALUES (@security_id, @ticker, @name, @type, @close_price, @close_price_as_of)
    ON CONFLICT(security_id) DO UPDATE SET
      close_price=excluded.close_price, close_price_as_of=excluded.close_price_as_of
  `);

  const upsertTx = db.prepare(`
    INSERT INTO investment_transactions (investment_transaction_id, account_id, security_id, date, name, quantity, amount, price, fees, type, subtype, iso_currency_code)
    VALUES (@investment_transaction_id, @account_id, @security_id, @date, @name, @quantity, @amount, @price, @fees, @type, @subtype, @iso_currency_code)
    ON CONFLICT(investment_transaction_id) DO UPDATE SET
      amount=excluded.amount, quantity=excluded.quantity, price=excluded.price,
      fees=excluded.fees, name=excluded.name
  `);

  while (true) {
    const resp = await plaidClient.investmentsTransactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { offset, count },
    });

    const batch = db.transaction(() => {
      for (const s of resp.data.securities) {
        upsertSecurity.run({
          security_id: s.security_id,
          ticker: s.ticker_symbol || null,
          name: s.name || "Unknown",
          type: s.type || null,
          close_price: s.close_price || null,
          close_price_as_of: s.close_price_as_of || null,
        });
      }
      for (const t of resp.data.investment_transactions) {
        upsertTx.run({
          investment_transaction_id: t.investment_transaction_id,
          account_id: t.account_id,
          security_id: t.security_id || null,
          date: t.date,
          name: t.name,
          quantity: t.quantity,
          amount: t.amount,
          price: t.price,
          fees: t.fees || null,
          type: t.type || null,
          subtype: t.subtype || null,
          iso_currency_code: t.iso_currency_code || null,
        });
      }
    });
    batch();

    totalFetched += resp.data.investment_transactions.length;
    if (totalFetched >= resp.data.total_investment_transactions) break;
    offset += count;
  }

  return { transactions: totalFetched };
}

/** Sync liabilities (credit, mortgage, student) */
export async function syncLiabilities(db: Database, accessToken: string) {
  const resp = await plaidClient.liabilitiesGet({ access_token: accessToken });

  const upsert = db.prepare(`
    INSERT INTO liabilities (account_id, type, interest_rate, origination_date, original_balance, current_balance, minimum_payment, next_payment_due,
      last_payment_amount, last_payment_date, credit_limit, last_statement_issue_date, is_overdue, apr_type,
      maturity_date, loan_type, property_address, escrow_balance,
      loan_status, loan_name, repayment_plan, expected_payoff_date, ytd_interest_paid, ytd_principal_paid, updated_at)
    VALUES (@account_id, @type, @interest_rate, @origination_date, @original_balance, @current_balance, @minimum_payment, @next_payment_due,
      @last_payment_amount, @last_payment_date, @credit_limit, @last_statement_issue_date, @is_overdue, @apr_type,
      @maturity_date, @loan_type, @property_address, @escrow_balance,
      @loan_status, @loan_name, @repayment_plan, @expected_payoff_date, @ytd_interest_paid, @ytd_principal_paid, datetime('now'))
    ON CONFLICT(account_id, type) DO UPDATE SET
      interest_rate=excluded.interest_rate, current_balance=excluded.current_balance,
      minimum_payment=excluded.minimum_payment, next_payment_due=excluded.next_payment_due,
      last_payment_amount=excluded.last_payment_amount, last_payment_date=excluded.last_payment_date,
      credit_limit=excluded.credit_limit, last_statement_issue_date=excluded.last_statement_issue_date,
      is_overdue=excluded.is_overdue, apr_type=excluded.apr_type,
      maturity_date=excluded.maturity_date, loan_type=excluded.loan_type,
      property_address=excluded.property_address, escrow_balance=excluded.escrow_balance,
      loan_status=excluded.loan_status, loan_name=excluded.loan_name,
      repayment_plan=excluded.repayment_plan, expected_payoff_date=excluded.expected_payoff_date,
      ytd_interest_paid=excluded.ytd_interest_paid, ytd_principal_paid=excluded.ytd_principal_paid,
      updated_at=datetime('now')
  `);

  const insertMany = db.transaction(() => {
    const credit = resp.data.liabilities.credit || [];
    for (const c of credit) {
      upsert.run({
        account_id: c.account_id,
        type: "credit",
        interest_rate: c.aprs?.[0]?.apr_percentage || null,
        origination_date: null,
        original_balance: null,
        current_balance: c.last_statement_balance,
        minimum_payment: c.minimum_payment_amount,
        next_payment_due: c.next_payment_due_date || null,
        last_payment_amount: c.last_payment_amount || null,
        last_payment_date: c.last_payment_date || null,
        credit_limit: null, // comes from accounts.balance_limit
        last_statement_issue_date: c.last_statement_issue_date || null,
        is_overdue: c.is_overdue ? 1 : 0,
        apr_type: c.aprs?.[0]?.apr_type || null,
        maturity_date: null,
        loan_type: null,
        property_address: null,
        escrow_balance: null,
        loan_status: null,
        loan_name: null,
        repayment_plan: null,
        expected_payoff_date: null,
        ytd_interest_paid: null,
        ytd_principal_paid: null,
      });
    }
    const mortgage = resp.data.liabilities.mortgage || [];
    for (const m of mortgage) {
      upsert.run({
        account_id: m.account_id,
        type: "mortgage",
        interest_rate: m.interest_rate?.percentage || null,
        origination_date: m.origination_date || null,
        original_balance: m.origination_principal_amount || null,
        current_balance: null, // actual balance in accounts.current_balance
        minimum_payment: m.last_payment_amount || null,
        next_payment_due: m.next_payment_due_date || null,
        last_payment_amount: m.last_payment_amount || null,
        last_payment_date: m.last_payment_date || null,
        credit_limit: null,
        last_statement_issue_date: null,
        is_overdue: null,
        apr_type: null,
        maturity_date: m.maturity_date || null,
        loan_type: m.loan_type_description || null,
        property_address: m.property_address ? JSON.stringify(m.property_address) : null,
        escrow_balance: m.escrow_balance || null,
        loan_status: null,
        loan_name: null,
        repayment_plan: null,
        expected_payoff_date: null,
        ytd_interest_paid: null,
        ytd_principal_paid: null,
      });
    }
    const student = resp.data.liabilities.student || [];
    for (const s of student) {
      upsert.run({
        account_id: s.account_id,
        type: "student",
        interest_rate: s.interest_rate_percentage || null,
        origination_date: s.origination_date || null,
        original_balance: s.origination_principal_amount || null,
        current_balance: null, // actual balance in accounts.current_balance
        minimum_payment: s.minimum_payment_amount || null,
        next_payment_due: s.next_payment_due_date || null,
        last_payment_amount: s.last_payment_amount || null,
        last_payment_date: s.last_payment_date || null,
        credit_limit: null,
        last_statement_issue_date: null,
        is_overdue: null,
        apr_type: null,
        maturity_date: null,
        loan_type: null,
        property_address: null,
        escrow_balance: null,
        loan_status: s.loan_status?.type || null,
        loan_name: s.loan_name || null,
        repayment_plan: s.repayment_plan?.description || null,
        expected_payoff_date: s.expected_payoff_date || null,
        ytd_interest_paid: s.ytd_interest_paid || null,
        ytd_principal_paid: s.ytd_principal_paid || null,
      });
    }
  });
  insertMany();

  return "ok";
}
