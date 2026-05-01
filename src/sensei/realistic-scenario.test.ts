import { describe, expect, it } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createBnplPlan, getBnplPressure } from "./bnpl.js";
import { evaluatePurchase, recordPurchaseDecision, savePurchaseConsultation } from "./purchase-consultant.js";
import { getFrictionCommitments, resolveFrictionCommitment } from "./strategic-friction.js";
import { getAssetVpu, logAssetUsage } from "./vpu.js";

type DB = InstanceType<typeof Database>;

function freshDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function iso(daysFromToday: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

function seedInstitution(db: DB): void {
  db.prepare(`
    INSERT INTO institutions (item_id, access_token, name, products)
    VALUES ('chase', 'tok', 'Chase', '["transactions","liabilities"]')
  `).run();
}

function seedAccount(db: DB, id: string, name: string, type: string, balance: number, available?: number): void {
  db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, type, current_balance, available_balance)
    VALUES (?, 'chase', ?, ?, ?, ?)
  `).run(id, name, type, balance, available ?? balance);
}

function tx(db: DB, id: string, accountId: string, amount: number, daysFromToday: number, name: string, category: string, merchant?: string): void {
  db.prepare(`
    INSERT INTO transactions (transaction_id, account_id, amount, date, name, merchant_name, category, pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, accountId, amount, iso(daysFromToday), name, merchant ?? null, category);
}

function seedAlexChen(db: DB): void {
  seedInstitution(db);
  seedAccount(db, "checking", "Chase Total Checking", "depository", 4200, 4200);
  seedAccount(db, "savings", "Emergency Fund", "depository", 6800, 6800);
  seedAccount(db, "freedom", "Chase Freedom", "credit", 1650, 6350);
  seedAccount(db, "roth", "Roth IRA", "investment", 18500, 18500);

  db.prepare(`
    INSERT INTO liabilities (account_id, type, current_balance, minimum_payment, next_payment_due, interest_rate)
    VALUES ('freedom', 'credit', 1650, 55, ?, 24.99)
  `).run(iso(8));

  db.prepare(`INSERT INTO budgets (category, monthly_limit) VALUES ('FOOD_AND_DRINK', 650)`).run();
  db.prepare(`INSERT INTO budgets (category, monthly_limit) VALUES ('GENERAL_MERCHANDISE', 450)`).run();
  db.prepare(`INSERT INTO budgets (category, monthly_limit) VALUES ('ENTERTAINMENT', 220)`).run();
  db.prepare(`INSERT INTO goals (name, target_amount, current_amount, target_date) VALUES ('Emergency Fund', 12000, 6800, ?)`).run(iso(180));
  db.prepare(`INSERT INTO goals (name, target_amount, current_amount, target_date) VALUES ('Japan Trip', 4200, 1350, ?)`).run(iso(240));
  db.prepare(`INSERT INTO goals (name, target_amount, current_amount, target_date) VALUES ('Bike Upgrade Fund', 2500, 900, ?)`).run(iso(120));

  db.prepare(`INSERT INTO recurring_bills (name, amount, day_of_month) VALUES ('Rent', 2350, ?)`).run(new Date(iso(6)).getUTCDate());
  db.prepare(`INSERT INTO recurring_bills (name, amount, day_of_month) VALUES ('Utilities', 180, ?)`).run(new Date(iso(12)).getUTCDate());
  db.prepare(`INSERT INTO recurring_bills (name, amount, day_of_month) VALUES ('Gym', 79, ?)`).run(new Date(iso(16)).getUTCDate());

  for (let month = 0; month < 6; month++) {
    const offset = -month * 30;
    tx(db, `pay-1-${month}`, "checking", -3900, offset - 2, "Payroll deposit", "INCOME", "Acme Robotics");
    tx(db, `pay-2-${month}`, "checking", -3900, offset - 17, "Payroll deposit", "INCOME", "Acme Robotics");
    tx(db, `rent-${month}`, "checking", 2350, offset - 1, "Rent", "RENT_AND_UTILITIES", "Avalon Apartments");
    tx(db, `groceries-${month}`, "checking", 460, offset - 5, "Groceries", "FOOD_AND_DRINK", "Trader Joe's");
    tx(db, `restaurants-${month}`, "freedom", 220, offset - 9, "Restaurants", "FOOD_AND_DRINK", "Various");
    tx(db, `coffee-${month}`, "freedom", 85, offset - 13, "Coffee", "FOOD_AND_DRINK", "Blue Bottle");
    tx(db, `transit-${month}`, "freedom", 140, offset - 18, "Gas and transit", "TRANSPORTATION", "Shell");
    tx(db, `savings-${month}`, "checking", 600, offset - 20, "Transfer to savings", "TRANSFER_OUT", "Chase");
    tx(db, `roth-${month}`, "checking", 350, offset - 22, "Roth IRA contribution", "TRANSFER_OUT", "Vanguard");
  }

  tx(db, "bike-shop-1", "freedom", 148, -14, "Cycling kit", "GENERAL_MERCHANDISE", "Rapha");
  tx(db, "bike-shop-2", "freedom", 86, -28, "Tubeless supplies", "GENERAL_MERCHANDISE", "REI");
  tx(db, "bestbuy-1", "freedom", 329, -35, "Headphones", "GENERAL_MERCHANDISE", "Best Buy");
  tx(db, "apple-1", "freedom", 119, -60, "AppleCare", "GENERAL_MERCHANDISE", "Apple");
  tx(db, "affirm-historical", "checking", 120, -11, "AFFIRM PAYMTHLY", "LOAN_PAYMENTS", "Affirm");
  tx(db, "klarna-historical", "checking", 55, -4, "Klarna installment", "LOAN_PAYMENTS", "Klarna");

  createBnplPlan(db, {
    provider: "Affirm",
    merchant: "Wahoo",
    itemName: "Bike computer",
    totalAmount: 480,
    remainingAmount: 360,
    installmentAmount: 120,
    installmentCount: 3,
    nextPaymentDate: iso(6),
    frequencyDays: 14,
  });
  createBnplPlan(db, {
    provider: "Klarna",
    merchant: "Nike",
    itemName: "Running shoes",
    totalAmount: 220,
    remainingAmount: 110,
    installmentAmount: 55,
    installmentCount: 2,
    nextPaymentDate: iso(4),
    frequencyDays: 14,
  });

  for (let i = 0; i < 12; i++) {
    logAssetUsage(db, { assetName: "Gravel bike", category: "cycling", purchasePrice: 2400, usageMetric: "ride", quantity: 2, usedAt: iso(-i * 14) });
  }
  for (let i = 0; i < 8; i++) {
    logAssetUsage(db, { assetName: "Gravel bike", category: "cycling", usageMetric: "mile", quantity: 32, usedAt: iso(-i * 14) });
  }
  for (let i = 0; i < 3; i++) {
    logAssetUsage(db, { assetName: "Torque wrench", category: "tool", purchasePrice: 180, usageMetric: "project", quantity: 1, usedAt: iso(-i * 45) });
  }
}

describe("realistic Sensei-Fi scenario", () => {
  it("handles BNPL pressure, VPU, purchase consulting, and strategic friction for Alex Chen", () => {
    const db = freshDb();
    seedAlexChen(db);

    const pressure = getBnplPressure(db, { days: 90 });
    expect(pressure.activePlanCount).toBe(2);
    expect(pressure.remainingBnpl).toBe(470);
    expect(pressure.windows.find(w => w.days === 30)?.amount).toBe(350);
    expect(pressure.collisions.length).toBeGreaterThan(0);

    const bikeVpu = getAssetVpu(db, "Gravel bike");
    expect(bikeVpu?.totalQuantity).toBeGreaterThan(20);
    expect(bikeVpu?.costPerUnit).toBeLessThan(120);

    const light = evaluatePurchase(db, {
      itemName: "Garmin Varia radar light",
      price: 149,
      category: "cycling",
      urgency: "low",
      expectedUsesPerMonth: 16,
      expectedMonths: 36,
    });
    expect(light.recommendation).toBe("buy");
    expect(light.value.valuePerUse).toBeLessThan(1);

    const concreteSaw = evaluatePurchase(db, {
      itemName: "Concrete saw",
      price: 900,
      category: "tool",
      rentCost: 85,
      expectedUsesPerMonth: 0.05,
      expectedMonths: 12,
      urgency: "high",
    });
    expect(concreteSaw.recommendation).toBe("rent");
    expect(concreteSaw.impulseGuard.join(" ")).toContain("Rent or borrow");

    const laptop = evaluatePurchase(db, {
      itemName: "MacBook Pro upgrade",
      price: 2499,
      category: "electronics",
      urgency: "high",
      paymentMode: "bnpl",
      installmentCount: 4,
    });
    expect(["wait", "skip", "rent"]).toContain(laptop.recommendation);
    expect(laptop.pressure.combined30).toBeGreaterThan(1000);

    const consultId = savePurchaseConsultation(db, laptop);
    const commitments = getFrictionCommitments(db);
    expect(commitments.map(c => c.type)).toContain("cooldown_48h");
    expect(commitments.map(c => c.type)).toContain("cash_price_check");

    recordPurchaseDecision(db, consultId, "skip", "Decided current laptop is fine after cooldown.");
    const event = db.prepare(`SELECT points, amount_avoided FROM strategic_friction_events WHERE consultation_id = ?`).get(consultId) as any;
    expect(event.points).toBeGreaterThan(100);
    expect(event.amount_avoided).toBe(2499);

    const cashCheck = commitments.find(c => c.type === "cash_price_check");
    expect(cashCheck).toBeTruthy();
    resolveFrictionCommitment(db, cashCheck!.id, "Would not buy at cash price.");
    const resolved = getFrictionCommitments(db, { status: "resolved" });
    expect(resolved.find(c => c.id === cashCheck!.id)?.resolution).toBe("Would not buy at cash price.");
  });
});
