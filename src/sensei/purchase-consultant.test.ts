import { describe, expect, it } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { evaluatePurchase, recordPurchaseDecision, savePurchaseConsultation } from "./purchase-consultant.js";
import { logAssetUsage } from "./vpu.js";

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

function seedAccount(db: DB, balance: number): void {
  db.prepare(`INSERT INTO institutions (item_id, access_token, name, products) VALUES ('inst', 'tok', 'Bank', '[]')`).run();
  db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, type, current_balance, available_balance)
    VALUES ('checking', 'inst', 'Checking', 'depository', ?, ?)
  `).run(balance, balance);
}

function seedCashFlow(db: DB, monthlyIncome = 6000, monthlySpend = 3500): void {
  for (let i = 0; i < 3; i++) {
    const date = daysAgo(10 + i * 30);
    db.prepare(`
      INSERT INTO transactions (transaction_id, account_id, amount, date, name, category)
      VALUES (?, 'checking', ?, ?, ?, ?)
    `).run(`income-${i}`, -monthlyIncome, date, "Paycheck", "INCOME");
    db.prepare(`
      INSERT INTO transactions (transaction_id, account_id, amount, date, name, category)
      VALUES (?, 'checking', ?, ?, ?, ?)
    `).run(`spend-${i}`, monthlySpend, date, "Living costs", "RENT_AND_UTILITIES");
  }
}

describe("purchase consultant", () => {
  it("recommends buy for a strong-value purchase with healthy liquidity", () => {
    const db = freshDb();
    seedAccount(db, 20000);
    seedCashFlow(db);

    const result = evaluatePurchase(db, {
      itemName: "Bike trainer",
      price: 600,
      category: "cycling",
      expectedUsesPerMonth: 12,
      expectedMonths: 36,
      urgency: "low",
    });

    expect(result.recommendation).toBe("buy");
    expect(result.value.valuePerUse).toBeLessThan(2);
    expect(result.liquidity.cashAfterPurchase).toBe(19400);
  });

  it("recommends skip when the purchase breaks liquidity", () => {
    const db = freshDb();
    seedAccount(db, 400);
    seedCashFlow(db, 3000, 2900);

    const result = evaluatePurchase(db, {
      itemName: "Laptop",
      price: 1800,
      category: "electronics",
      urgency: "high",
    });

    expect(result.recommendation).toBe("skip");
    expect(result.scores.liquidity).toBeLessThan(30);
    expect(result.impulseGuard.join(" ")).toContain("Move the avoided spend");
  });

  it("suggests renting when value is uncertain and rental is available", () => {
    const db = freshDb();
    seedAccount(db, 8000);
    seedCashFlow(db);

    const result = evaluatePurchase(db, {
      itemName: "Concrete saw",
      price: 900,
      category: "tool",
      rentCost: 80,
      expectedUsesPerMonth: 0.1,
      expectedMonths: 12,
      urgency: "high",
    });

    expect(result.recommendation).toBe("rent");
    expect(result.value.rentalBreakEvenUses).toBe(12);
    expect(result.impulseGuard.join(" ")).toContain("Rent or borrow");
  });

  it("includes existing BNPL pressure in the decision", () => {
    const db = freshDb();
    seedAccount(db, 5000);
    seedCashFlow(db);
    db.prepare(`
      INSERT INTO bnpl_plans (id, provider, item_name, total_amount, remaining_amount, installment_amount, installment_count, next_payment_date)
      VALUES (1, 'Affirm', 'Camera', 1200, 1200, 300, 4, date('now', '+7 days'))
    `).run();
    db.prepare(`
      INSERT INTO bnpl_installments (plan_id, installment_number, amount, due_date)
      VALUES (1, 1, 300, date('now', '+7 days')),
             (1, 2, 300, date('now', '+21 days')),
             (1, 3, 300, date('now', '+35 days')),
             (1, 4, 300, date('now', '+49 days'))
    `).run();

    const result = evaluatePurchase(db, {
      itemName: "Headphones",
      price: 400,
      category: "electronics",
    });

    expect(result.pressure.currentBnpl30).toBe(600);
    expect(result.pressure.combined30).toBe(1000);
  });

  it("saves consultations and records decisions", () => {
    const db = freshDb();
    seedAccount(db, 10000);
    seedCashFlow(db);
    const result = evaluatePurchase(db, {
      itemName: "Course",
      price: 300,
      category: "education",
    });

    const id = savePurchaseConsultation(db, result);
    recordPurchaseDecision(db, id, "wait", "Waiting 48 hours");

    const consult = db.prepare(`SELECT recommendation FROM purchase_consultations WHERE id = ?`).get(id) as any;
    const decision = db.prepare(`SELECT decision, note FROM purchase_decisions WHERE consultation_id = ?`).get(id) as any;
    expect(consult.recommendation).toBe(result.recommendation);
    expect(decision.decision).toBe("wait");
    expect(decision.note).toBe("Waiting 48 hours");
  });

  it("uses historical VPU usage as the default purchase forecast", () => {
    const db = freshDb();
    seedAccount(db, 15000);
    seedCashFlow(db);
    logAssetUsage(db, { assetName: "Road bike", category: "cycling", usageMetric: "ride", quantity: 12 });

    const result = evaluatePurchase(db, {
      itemName: "Indoor trainer",
      price: 600,
      category: "cycling",
      expectedMonths: 10,
    });

    expect(result.input.expectedUsesPerMonth).toBe(12);
    expect(result.value.usageSource).toBe("history");
    expect(result.value.valuePerUse).toBe(5);
  });

  it("records strategic friction points when a user accepts a wait/skip/rent nudge", () => {
    const db = freshDb();
    seedAccount(db, 10000);
    seedCashFlow(db);
    const result = evaluatePurchase(db, {
      itemName: "Camera lens",
      price: 500,
      category: "electronics",
    });
    const id = savePurchaseConsultation(db, result);

    recordPurchaseDecision(db, id, "skip", "Did not need it.");

    const event = db.prepare(`SELECT outcome, points, amount_avoided FROM strategic_friction_events WHERE consultation_id = ?`).get(id) as any;
    expect(event.outcome).toBe("accepted");
    expect(event.points).toBe(50);
    expect(event.amount_avoided).toBe(500);
  });
});
