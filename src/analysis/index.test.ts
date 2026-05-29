import { describe, expect, it } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { computeFinancialAnalysis, getLatestFinancialAnalysis, runFinancialAnalysis } from "./index.js";

type DB = InstanceType<typeof Database>;

function freshDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function daysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function seedRealisticFinancialLife(db: DB): void {
  db.prepare(`INSERT INTO institutions (item_id, access_token, name, products) VALUES ('bank', 'manual', 'Credit Union', '[]')`).run();
  db.prepare(`INSERT INTO institutions (item_id, access_token, name, products) VALUES ('brokerage', 'manual', 'Brokerage', '[]')`).run();
  db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, type, subtype, current_balance, available_balance, balance_limit)
    VALUES
      ('checking', 'bank', 'Main Checking', 'depository', 'checking', 7200, 7200, NULL),
      ('savings', 'bank', 'Emergency Savings', 'depository', 'savings', 9500, 9500, NULL),
      ('visa', 'bank', 'Rewards Visa', 'credit', 'credit card', 4200, NULL, 15000),
      ('auto', 'bank', 'Auto Loan', 'loan', 'auto', 12800, NULL, NULL),
      ('ira', 'brokerage', 'Roth IRA', 'investment', 'ira', 42000, NULL, NULL)
  `).run();
  db.prepare(`
    INSERT INTO liabilities (account_id, type, interest_rate, current_balance, minimum_payment, next_payment_due)
    VALUES
      ('visa', 'credit', 24.9, 4200, 130, ?),
      ('auto', 'loan', 7.2, 12800, 385, ?)
  `).run(daysFromNow(8), daysFromNow(12));
  db.prepare(`
    INSERT INTO securities (security_id, name, ticker, type, close_price)
    VALUES
      ('vti', 'Vanguard Total Stock Market ETF', 'VTI', 'etf', 260),
      ('bnd', 'Vanguard Total Bond Market ETF', 'BND', 'etf', 72)
  `).run();
  db.prepare(`
    INSERT INTO holdings (account_id, security_id, quantity, value, price)
    VALUES
      ('ira', 'vti', 140, 36000, 260),
      ('ira', 'bnd', 80, 6000, 72)
  `).run();
  db.prepare(`
    INSERT INTO recurring (stream_id, account_id, merchant_name, description, frequency, avg_amount, last_date, is_active, stream_type, status)
    VALUES
      ('rent', 'checking', 'Apartment', 'Rent', 'MONTHLY', 2100, ?, 1, 'outflow', 'MATURE'),
      ('gym', 'checking', 'Gym', 'Fitness membership', 'MONTHLY', 82, ?, 1, 'outflow', 'MATURE'),
      ('internet', 'checking', 'Fiber Internet', 'Internet', 'MONTHLY', 75, ?, 1, 'outflow', 'MATURE')
  `).run(daysAgo(3), daysAgo(9), daysAgo(11));
  db.prepare(`
    INSERT INTO recurring_bills (name, amount, day_of_month, type, account_id)
    VALUES ('Phone Plan', 92, 18, 'bill', 'checking')
  `).run();
  db.prepare(`
    INSERT INTO bnpl_plans (id, provider, merchant, item_name, total_amount, remaining_amount, installment_amount, installment_count, next_payment_date)
    VALUES (1, 'Affirm', 'Bike Shop', 'Cycling computer', 480, 240, 120, 4, ?)
  `).run(daysFromNow(6));
  db.prepare(`
    INSERT INTO bnpl_installments (plan_id, installment_number, amount, due_date)
    VALUES (1, 1, 120, ?), (1, 2, 120, ?)
  `).run(daysFromNow(6), daysFromNow(20));

  const insertTxn = db.prepare(`
    INSERT INTO transactions (transaction_id, account_id, amount, date, name, merchant_name, category, subcategory, pending)
    VALUES (?, 'checking', ?, ?, ?, ?, ?, ?, 0)
  `);
  for (let i = 0; i < 8; i++) {
    const base = 7 + i * 14;
    insertTxn.run(`pay-${i}`, -3650, daysAgo(base), "ACME PAYROLL DIRECT DEP", "ACME Payroll", "INCOME", null);
    insertTxn.run(`groceries-${i}`, 185, daysAgo(base - 1), "WHOLE FOODS", "Whole Foods", "FOOD_AND_DRINK_GROCERIES", null);
    insertTxn.run(`dining-${i}`, 92, daysAgo(base - 2), "RESTAURANT", "Restaurant", "FOOD_AND_DRINK_RESTAURANT", null);
    insertTxn.run(`gas-${i}`, 48, daysAgo(base - 3), "SHELL", "Shell", "TRANSPORTATION_GAS", null);
    insertTxn.run(`invest-${i}`, 500, daysAgo(base - 4), "VANGUARD TRANSFER", "Vanguard", "TRANSFER_OUT", null);
  }
}

describe("financial analysis", () => {
  it("computes the GUI cockpit models from raw transactions and accounts", () => {
    const db = freshDb();
    seedRealisticFinancialLife(db);

    const analysis = computeFinancialAnalysis(db);

    expect(analysis.paycheckCycle.detected).toBe(true);
    expect(analysis.paycheckCycle.cadenceDays).toBe(14);
    expect(analysis.cashFlowForecast.monthlyIncome).toBeGreaterThan(6000);
    expect(analysis.recurringObligationCalendar.next30Days).toBeGreaterThan(2000);
    expect(analysis.futureAccountBalanceSimulation.points).toHaveLength(90);
    expect(analysis.trueAffordability.safeToSpendToday).toBeGreaterThanOrEqual(0);
    expect(analysis.emergencyFundRunway.runwayMonths).toBeGreaterThan(1);
    expect(analysis.debtAvalanche.payoffOrder[0].accountName).toBe("Rewards Visa");
    expect(analysis.retirementProjection.projected20Year).toBeGreaterThan(analysis.retirementProjection.currentInvestments);
    expect(analysis.scenarioSimulation.scenarios).toHaveLength(4);
    expect(analysis.taxAwarePlanning.estimatedAnnualGrossIncome).toBeGreaterThan(70_000);
    expect(analysis.investmentAllocation.allocation.length).toBeGreaterThan(0);
    expect(analysis.paycheckPressureMap.periods.length).toBeGreaterThan(0);
    expect(analysis.insights.length).toBeGreaterThan(0);
  });

  it("persists analysis snapshots and searchable insight cards", () => {
    const db = freshDb();
    seedRealisticFinancialLife(db);

    const analysis = runFinancialAnalysis(db);
    const latest = getLatestFinancialAnalysis(db);
    const insightCount = db.prepare(`SELECT COUNT(*) as count FROM financial_insights`).get() as { count: number };

    expect(latest?.generatedAt).toBe(analysis.generatedAt);
    expect(insightCount.count).toBe(analysis.insights.length);
  });

  it("treats active 0% promo APR as the effective debt APR", () => {
    const db = freshDb();
    seedRealisticFinancialLife(db);
    db.prepare(`
      INSERT INTO liability_apr_terms
        (account_id, promo_apr, promo_start_date, promo_end_date, post_promo_apr, enabled, source)
      VALUES ('visa', 0, '2026-01-01', '2026-12-31', 29.9, 1, 'user')
    `).run();

    const analysis = computeFinancialAnalysis(db, "2026-06-15");
    const visa = analysis.debtAvalanche.payoffOrder.find(d => d.accountName === "Rewards Visa");

    expect(analysis.debtAvalanche.payoffOrder[0].accountName).toBe("Auto Loan");
    expect(visa?.apr).toBe(0);
  });

  it("falls back to post-promo APR after the promo window ends", () => {
    const db = freshDb();
    seedRealisticFinancialLife(db);
    db.prepare(`
      INSERT INTO liability_apr_terms
        (account_id, promo_apr, promo_start_date, promo_end_date, post_promo_apr, enabled, source)
      VALUES ('visa', 0, '2026-01-01', '2026-12-31', 29.9, 1, 'user')
    `).run();

    const analysis = computeFinancialAnalysis(db, "2027-01-15");
    const visa = analysis.debtAvalanche.payoffOrder.find(d => d.accountName === "Rewards Visa");

    expect(analysis.debtAvalanche.payoffOrder[0].accountName).toBe("Rewards Visa");
    expect(visa?.apr).toBe(29.9);
  });
});
