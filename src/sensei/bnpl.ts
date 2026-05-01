import type Database from "libsql";
import { getUpcomingBills } from "../db/bills.js";

export type BnplInstallmentStatus = "scheduled" | "paid" | "missed" | "canceled";
export type BnplPlanStatus = "active" | "completed" | "canceled";

export interface CreateBnplPlanInput {
  provider?: string;
  merchant?: string;
  itemName: string;
  totalAmount: number;
  remainingAmount?: number;
  installmentAmount?: number;
  installmentCount: number;
  nextPaymentDate: string;
  frequencyDays?: number;
  purchaseDate?: string;
  purchaseTransactionId?: string;
  note?: string;
}

export interface BnplPlan {
  id: number;
  provider: string | null;
  merchant: string | null;
  itemName: string;
  totalAmount: number;
  remainingAmount: number;
  installmentAmount: number;
  installmentCount: number;
  nextPaymentDate: string | null;
  frequencyDays: number;
  status: BnplPlanStatus;
  purchaseDate: string | null;
  note: string | null;
}

export interface BnplInstallment {
  id: number;
  planId: number;
  provider: string | null;
  merchant: string | null;
  itemName: string;
  installmentNumber: number;
  amount: number;
  dueDate: string;
  status: BnplInstallmentStatus;
  paidAt: string | null;
}

export interface BnplPressure {
  asOf: string;
  activePlanCount: number;
  remainingBnpl: number;
  windows: {
    days: number;
    amount: number;
  }[];
  monthly: {
    month: string;
    bnplAmount: number;
    fixedObligationLoad: number;
    totalObligationLoad: number;
  }[];
  nextInstallments: BnplInstallment[];
  collisions: {
    date: string;
    bnplAmount: number;
    otherAmount: number;
    names: string[];
  }[];
}

const BNPL_PROVIDER_PATTERNS = [
  "affirm",
  "klarna",
  "afterpay",
  "sezzle",
  "zip",
  "quadpay",
  "paypal pay later",
  "pay in 4",
  "paymthly",
];

export function createBnplPlan(db: Database.Database, input: CreateBnplPlanInput): number {
  validateCreateInput(input);
  const frequencyDays = input.frequencyDays ?? 14;
  const remainingAmount = roundMoney(input.remainingAmount ?? input.totalAmount);
  const installmentAmounts = splitIntoInstallments(remainingAmount, input.installmentCount, input.installmentAmount);
  const installmentAmount = input.installmentAmount ?? installmentAmounts[0];

  const insertPlan = db.prepare(`
    INSERT INTO bnpl_plans (
      provider, merchant, item_name, total_amount, remaining_amount, installment_amount,
      installment_count, next_payment_date, frequency_days, status, purchase_date,
      purchase_transaction_id, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const insertInstallment = db.prepare(`
    INSERT INTO bnpl_installments (plan_id, installment_number, amount, due_date, status)
    VALUES (?, ?, ?, ?, 'scheduled')
  `);

  const create = db.transaction(() => {
    const info = insertPlan.run(
      input.provider?.trim() || null,
      input.merchant?.trim() || null,
      input.itemName.trim(),
      roundMoney(input.totalAmount),
      remainingAmount,
      installmentAmount,
      input.installmentCount,
      input.nextPaymentDate,
      frequencyDays,
      input.purchaseDate ?? new Date().toISOString().slice(0, 10),
      input.purchaseTransactionId ?? null,
      input.note?.trim() || null,
    );
    const planId = Number(info.lastInsertRowid);
    let dueDate = parseIsoDate(input.nextPaymentDate);

    for (let i = 0; i < installmentAmounts.length; i++) {
      insertInstallment.run(
        planId,
        i + 1,
        installmentAmounts[i],
        formatDate(dueDate),
      );
      dueDate = addDays(dueDate, frequencyDays);
    }

    return planId;
  });

  return create();
}

export function getBnplPlans(db: Database.Database, status: BnplPlanStatus | "all" = "active"): BnplPlan[] {
  const where = status === "all" ? "" : "WHERE status = ?";
  const rows = db.prepare(`
    SELECT id, provider, merchant, item_name, total_amount, remaining_amount, installment_amount,
           installment_count, next_payment_date, frequency_days, status, purchase_date, note
    FROM bnpl_plans
    ${where}
    ORDER BY status, COALESCE(next_payment_date, created_at), id
  `).all(...(status === "all" ? [] : [status])) as any[];

  return rows.map(mapPlan);
}

export function getBnplLedger(db: Database.Database, options: {
  days?: number;
  status?: BnplInstallmentStatus | "open" | "all";
  asOf?: Date;
} = {}): BnplInstallment[] {
  const asOf = startOfUtcDay(options.asOf ?? new Date());
  const end = addDays(asOf, options.days ?? 90);
  const status = options.status ?? "open";
  const conditions = ["i.due_date BETWEEN ? AND ?"];
  const params: any[] = [formatDate(asOf), formatDate(end)];

  if (status === "open") {
    conditions.push("i.status = 'scheduled'");
  } else if (status !== "all") {
    conditions.push("i.status = ?");
    params.push(status);
  }

  const rows = db.prepare(`
    SELECT i.id, i.plan_id, p.provider, p.merchant, p.item_name, i.installment_number,
           i.amount, i.due_date, i.status, i.paid_at
    FROM bnpl_installments i
    JOIN bnpl_plans p ON p.id = i.plan_id
    WHERE ${conditions.join(" AND ")}
      AND p.status = 'active'
    ORDER BY i.due_date, i.amount DESC, i.id
  `).all(...params) as any[];

  return rows.map(mapInstallment);
}

export function getBnplPressure(db: Database.Database, options: { days?: number; asOf?: Date } = {}): BnplPressure {
  const asOf = startOfUtcDay(options.asOf ?? new Date());
  const days = options.days ?? 90;
  const ledger = getBnplLedger(db, { days, asOf, status: "open" });
  const fixedMonthlyLoad = getFixedMonthlyObligationLoad(db);
  const activePlans = getBnplPlans(db, "active");
  const remainingBnpl = roundMoney(activePlans.reduce((sum, plan) => sum + plan.remainingAmount, 0));

  const windows = [30, 60, 90].map((windowDays) => ({
    days: windowDays,
    amount: roundMoney(sumInstallmentsThrough(ledger, addDays(asOf, windowDays))),
  }));

  const monthCount = Math.max(1, Math.ceil(days / 30));
  const monthly = Array.from({ length: monthCount }, (_, index) => {
    const cursor = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + index, 1));
    const month = cursor.toISOString().slice(0, 7);
    const bnplAmount = roundMoney(ledger
      .filter((i) => i.dueDate.startsWith(month))
      .reduce((sum, i) => sum + i.amount, 0));

    return {
      month,
      bnplAmount,
      fixedObligationLoad: fixedMonthlyLoad,
      totalObligationLoad: roundMoney(fixedMonthlyLoad + bnplAmount),
    };
  });

  return {
    asOf: formatDate(asOf),
    activePlanCount: activePlans.length,
    remainingBnpl,
    windows,
    monthly,
    nextInstallments: ledger.slice(0, 8),
    collisions: getPaymentCollisions(db, ledger, days, asOf),
  };
}

export function markBnplInstallmentPaid(db: Database.Database, installmentId: number, paidAt?: string, transactionId?: string): void {
  const row = db.prepare(`
    SELECT plan_id, amount FROM bnpl_installments WHERE id = ?
  `).get(installmentId) as { plan_id: number; amount: number } | undefined;
  if (!row) throw new Error(`BNPL installment ${installmentId} was not found.`);

  const pay = db.transaction(() => {
    db.prepare(`
      UPDATE bnpl_installments
      SET status = 'paid', paid_at = ?, paid_transaction_id = ?
      WHERE id = ?
    `).run(paidAt ?? new Date().toISOString().slice(0, 10), transactionId ?? null, installmentId);

    db.prepare(`
      UPDATE bnpl_plans
      SET remaining_amount = MAX(0, remaining_amount - ?),
          next_payment_date = (
            SELECT MIN(due_date) FROM bnpl_installments
            WHERE plan_id = ? AND status = 'scheduled'
          )
      WHERE id = ?
    `).run(row.amount, row.plan_id, row.plan_id);

    const open = db.prepare(`
      SELECT COUNT(*) as count FROM bnpl_installments WHERE plan_id = ? AND status = 'scheduled'
    `).get(row.plan_id) as { count: number };
    if (open.count === 0) {
      db.prepare(`UPDATE bnpl_plans SET status = 'completed', remaining_amount = 0 WHERE id = ?`).run(row.plan_id);
    }
  });

  pay();
}

export function findPotentialBnplTransactions(db: Database.Database, days = 180): {
  transactionId: string;
  date: string;
  name: string;
  merchant: string | null;
  amount: number;
}[] {
  const since = formatDate(addDays(startOfUtcDay(new Date()), -days));
  const rows = db.prepare(`
    SELECT transaction_id, date, name, merchant_name, amount
    FROM transactions
    WHERE amount > 0 AND date >= ?
      AND (
        LOWER(COALESCE(merchant_name, '')) LIKE ?
        OR LOWER(name) LIKE ?
      )
    ORDER BY date DESC, amount DESC
    LIMIT 50
  `);

  const results: any[] = [];
  for (const pattern of BNPL_PROVIDER_PATTERNS) {
    results.push(...rows.all(since, `%${pattern}%`, `%${pattern}%`) as any[]);
  }

  const seen = new Set<string>();
  return results
    .filter((row) => {
      if (seen.has(row.transaction_id)) return false;
      seen.add(row.transaction_id);
      return true;
    })
    .map((row) => ({
      transactionId: row.transaction_id,
      date: row.date,
      name: row.name,
      merchant: row.merchant_name,
      amount: row.amount,
    }));
}

function validateCreateInput(input: CreateBnplPlanInput): void {
  if (!input.itemName.trim()) throw new Error("BNPL item name is required.");
  if (!Number.isFinite(input.totalAmount) || input.totalAmount <= 0) throw new Error("BNPL total amount must be positive.");
  if (!Number.isInteger(input.installmentCount) || input.installmentCount <= 0) throw new Error("BNPL installment count must be a positive integer.");
  if (input.installmentAmount !== undefined && (!Number.isFinite(input.installmentAmount) || input.installmentAmount <= 0)) {
    throw new Error("BNPL installment amount must be positive.");
  }
  if (input.remainingAmount !== undefined && (!Number.isFinite(input.remainingAmount) || input.remainingAmount <= 0)) {
    throw new Error("BNPL remaining amount must be positive.");
  }
  if ((input.frequencyDays ?? 14) <= 0) throw new Error("BNPL frequency days must be positive.");
  parseIsoDate(input.nextPaymentDate);
}

function splitIntoInstallments(total: number, count: number, requestedInstallmentAmount?: number): number[] {
  if (requestedInstallmentAmount !== undefined) {
    const amounts = Array.from({ length: count }, () => roundMoney(requestedInstallmentAmount));
    const scheduled = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
    const diff = roundMoney(total - scheduled);
    amounts[amounts.length - 1] = roundMoney(amounts[amounts.length - 1] + diff);
    return amounts;
  }

  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const remainder = cents % count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

function getFixedMonthlyObligationLoad(db: Database.Database): number {
  const recurring = db.prepare(`
    SELECT frequency, avg_amount, stream_type
    FROM recurring
    WHERE is_active = 1 AND stream_type = 'outflow'
  `).all() as { frequency: string; avg_amount: number }[];
  const recurringMonthly = recurring.reduce((sum, row) => sum + normalizeToMonthly(row.avg_amount, row.frequency), 0);

  const manual = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM recurring_bills
  `).get() as { total: number };

  const debtMinimums = db.prepare(`
    SELECT COALESCE(SUM(minimum_payment), 0) as total
    FROM liabilities
    WHERE minimum_payment IS NOT NULL
  `).get() as { total: number };

  return roundMoney(recurringMonthly + (manual.total || 0) + (debtMinimums.total || 0));
}

function normalizeToMonthly(amount: number, frequency: string): number {
  switch (frequency) {
    case "WEEKLY":
      return amount * 52 / 12;
    case "BIWEEKLY":
      return amount * 26 / 12;
    case "SEMI_MONTHLY":
      return amount * 2;
    case "ANNUALLY":
      return amount / 12;
    case "MONTHLY":
    default:
      return amount;
  }
}

function getPaymentCollisions(db: Database.Database, ledger: BnplInstallment[], days: number, asOf: Date): BnplPressure["collisions"] {
  const bills = getUpcomingBills(db, days);
  const billByDate = new Map<string, { amount: number; names: string[] }>();
  for (const bill of bills) {
    const date = formatDate(bill.date);
    const current = billByDate.get(date) ?? { amount: 0, names: [] };
    current.amount += bill.amount;
    current.names.push(bill.name);
    billByDate.set(date, current);
  }

  const bnplByDate = new Map<string, number>();
  for (const installment of ledger) {
    const due = parseIsoDate(installment.dueDate);
    if (due < asOf || due > addDays(asOf, days)) continue;
    bnplByDate.set(installment.dueDate, (bnplByDate.get(installment.dueDate) ?? 0) + installment.amount);
  }

  const collisions: BnplPressure["collisions"] = [];
  for (const [date, bnplAmount] of bnplByDate) {
    const bill = billByDate.get(date);
    if (!bill) continue;
    collisions.push({
      date,
      bnplAmount: roundMoney(bnplAmount),
      otherAmount: roundMoney(bill.amount),
      names: bill.names,
    });
  }
  return collisions;
}

function sumInstallmentsThrough(installments: BnplInstallment[], date: Date): number {
  return installments
    .filter((installment) => parseIsoDate(installment.dueDate) <= date)
    .reduce((sum, installment) => sum + installment.amount, 0);
}

function mapPlan(row: any): BnplPlan {
  return {
    id: row.id,
    provider: row.provider,
    merchant: row.merchant,
    itemName: row.item_name,
    totalAmount: row.total_amount,
    remainingAmount: row.remaining_amount,
    installmentAmount: row.installment_amount,
    installmentCount: row.installment_count,
    nextPaymentDate: row.next_payment_date,
    frequencyDays: row.frequency_days,
    status: row.status,
    purchaseDate: row.purchase_date,
    note: row.note,
  };
}

function mapInstallment(row: any): BnplInstallment {
  return {
    id: row.id,
    planId: row.plan_id,
    provider: row.provider,
    merchant: row.merchant,
    itemName: row.item_name,
    installmentNumber: row.installment_number,
    amount: row.amount,
    dueDate: row.due_date,
    status: row.status,
    paidAt: row.paid_at,
  };
}

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  const date = new Date(value + "T00:00:00Z");
  if (isNaN(date.getTime())) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  return date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
