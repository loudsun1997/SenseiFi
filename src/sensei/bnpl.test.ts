import { describe, expect, it } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import {
  createBnplPlan,
  findPotentialBnplTransactions,
  getBnplLedger,
  getBnplPressure,
  markBnplInstallmentPaid,
} from "./bnpl.js";

type DB = InstanceType<typeof Database>;

function freshDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function seedInstitutionAndAccount(db: DB): void {
  db.prepare(`INSERT INTO institutions (item_id, access_token, name, products) VALUES ('inst', 'tok', 'Bank', '[]')`).run();
  db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, type, current_balance)
    VALUES ('checking', 'inst', 'Checking', 'depository', 5000)
  `).run();
}

describe("BNPL pressure ledger", () => {
  it("creates a chronological installment ledger and pressure windows", () => {
    const db = freshDb();

    createBnplPlan(db, {
      provider: "Affirm",
      merchant: "Canyon",
      itemName: "Bike trainer",
      totalAmount: 400,
      installmentCount: 4,
      nextPaymentDate: addDays(7),
      frequencyDays: 14,
    });

    const ledger = getBnplLedger(db, { days: 90 });
    expect(ledger).toHaveLength(4);
    expect(ledger.map((i) => i.amount)).toEqual([100, 100, 100, 100]);
    expect(ledger[0].provider).toBe("Affirm");

    const pressure = getBnplPressure(db, { days: 90 });
    expect(pressure.activePlanCount).toBe(1);
    expect(pressure.remainingBnpl).toBe(400);
    expect(pressure.windows.find((w) => w.days === 30)?.amount).toBe(200);
    expect(pressure.windows.find((w) => w.days === 90)?.amount).toBe(400);
    expect(pressure.nextInstallments[0].itemName).toBe("Bike trainer");
  });

  it("adds BNPL to fixed obligation load by month", () => {
    const db = freshDb();
    seedInstitutionAndAccount(db);
    db.prepare(`INSERT INTO recurring_bills (name, amount, day_of_month) VALUES ('Rent', 1800, 1)`).run();
    db.prepare(`
      INSERT INTO liabilities (account_id, type, minimum_payment, next_payment_due)
      VALUES ('checking', 'credit', 75, ?)
    `).run(addDays(10));

    createBnplPlan(db, {
      provider: "Klarna",
      itemName: "Monitor",
      totalAmount: 240,
      installmentCount: 3,
      nextPaymentDate: addDays(5),
      frequencyDays: 30,
    });

    const pressure = getBnplPressure(db, { days: 90 });
    const firstBnplMonth = pressure.monthly.find((m) => m.bnplAmount > 0);
    expect(firstBnplMonth?.fixedObligationLoad).toBe(1875);
    expect(firstBnplMonth?.totalObligationLoad).toBe((firstBnplMonth?.bnplAmount || 0) + 1875);
  });

  it("marks installments paid and completes the plan", () => {
    const db = freshDb();
    createBnplPlan(db, {
      provider: "Afterpay",
      itemName: "Shoes",
      totalAmount: 100,
      installmentCount: 2,
      nextPaymentDate: addDays(1),
      frequencyDays: 14,
    });

    const [first, second] = getBnplLedger(db, { days: 30 });
    markBnplInstallmentPaid(db, first.id, addDays(1));
    expect(getBnplPressure(db, { days: 30 }).remainingBnpl).toBe(50);

    markBnplInstallmentPaid(db, second.id, addDays(15));
    expect(getBnplPressure(db, { days: 30 }).activePlanCount).toBe(0);
    expect(getBnplLedger(db, { days: 30 })).toHaveLength(0);
  });

  it("finds likely BNPL transactions from known providers", () => {
    const db = freshDb();
    seedInstitutionAndAccount(db);
    db.prepare(`
      INSERT INTO transactions (transaction_id, account_id, amount, date, name, merchant_name, category)
      VALUES ('txn-1', 'checking', 39.99, ?, 'AFFIRM PAYMTHLY', 'Affirm', 'LOAN_PAYMENTS')
    `).run(addDays(-3));

    const candidates = findPotentialBnplTransactions(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].transactionId).toBe("txn-1");
  });
});
