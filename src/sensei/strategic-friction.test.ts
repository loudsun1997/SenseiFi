import { describe, expect, it } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { evaluatePurchase, savePurchaseConsultation } from "./purchase-consultant.js";
import { getFrictionCommitments, resolveFrictionCommitment } from "./strategic-friction.js";

type DB = InstanceType<typeof Database>;

function freshDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedAccount(db: DB, balance: number): void {
  db.prepare(`INSERT INTO institutions (item_id, access_token, name, products) VALUES ('inst', 'tok', 'Bank', '[]')`).run();
  db.prepare(`
    INSERT INTO accounts (account_id, item_id, name, type, current_balance, available_balance)
    VALUES ('checking', 'inst', 'Checking', 'depository', ?, ?)
  `).run(balance, balance);
}

describe("strategic friction commitments", () => {
  it("creates active commitments for a wait recommendation", () => {
    const db = freshDb();
    seedAccount(db, 8000);
    const result = evaluatePurchase(db, {
      itemName: "Camera lens",
      price: 900,
      category: "electronics",
      urgency: "normal",
      expectedUsesPerMonth: 1,
      expectedMonths: 6,
    });

    const consultId = savePurchaseConsultation(db, result);
    const commitments = getFrictionCommitments(db);

    expect(consultId).toBeGreaterThan(0);
    expect(commitments.length).toBeGreaterThanOrEqual(1);
    expect(commitments.map(c => c.type)).toContain("cooldown_48h");
    expect(commitments[0].itemName).toBe("Camera lens");
  });

  it("creates BNPL cash-price checks", () => {
    const db = freshDb();
    seedAccount(db, 5000);
    const result = evaluatePurchase(db, {
      itemName: "Watch",
      price: 1200,
      category: "electronics",
      paymentMode: "bnpl",
      urgency: "high",
    });

    savePurchaseConsultation(db, result);
    const commitments = getFrictionCommitments(db);
    expect(commitments.map(c => c.type)).toContain("cash_price_check");
  });

  it("resolves commitments", () => {
    const db = freshDb();
    seedAccount(db, 8000);
    const result = evaluatePurchase(db, {
      itemName: "Tool",
      price: 700,
      category: "tool",
      rentCost: 80,
      expectedUsesPerMonth: 0.1,
      expectedMonths: 6,
      urgency: "high",
    });

    savePurchaseConsultation(db, result);
    const [commitment] = getFrictionCommitments(db);
    resolveFrictionCommitment(db, commitment.id, "Rented first and skipped buying.");

    const active = getFrictionCommitments(db);
    const resolved = getFrictionCommitments(db, { status: "resolved" });
    expect(active.find(c => c.id === commitment.id)).toBeUndefined();
    expect(resolved.find(c => c.id === commitment.id)?.resolution).toBe("Rented first and skipped buying.");
  });
});
