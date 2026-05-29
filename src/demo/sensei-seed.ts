import Database from "libsql";
import { resolve } from "path";
import { seedDemoDb } from "./seed.js";
import { createBnplPlan } from "../sensei/bnpl.js";
import { evaluatePurchase, recordPurchaseDecision, savePurchaseConsultation } from "../sensei/purchase-consultant.js";
import { getFrictionCommitments, resolveFrictionCommitment } from "../sensei/strategic-friction.js";
import { logAssetUsage } from "../sensei/vpu.js";

export function seedSenseiDemoDb(dbPath: string): void {
  const resolved = resolve(dbPath);
  seedDemoDb(resolved);

  const db = new Database(resolved);
  db.pragma("foreign_keys = ON");

  seedSenseiState(db);

  const counts = {
    bnplPlans: count(db, "bnpl_plans"),
    bnplInstallments: count(db, "bnpl_installments"),
    usageLogs: count(db, "asset_usage"),
    consultations: count(db, "purchase_consultations"),
    frictionCommitments: count(db, "strategic_friction_commitments"),
    frictionEvents: count(db, "strategic_friction_events"),
  };

  console.log("\nSensei-Fi demo layer seeded successfully!\n");
  console.log(`  BNPL Plans:          ${counts.bnplPlans}`);
  console.log(`  BNPL Installments:   ${counts.bnplInstallments}`);
  console.log(`  Usage Logs:          ${counts.usageLogs}`);
  console.log(`  Consultations:       ${counts.consultations}`);
  console.log(`  Friction Tasks:      ${counts.frictionCommitments}`);
  console.log(`  Frugality Events:    ${counts.frictionEvents}`);
  console.log(`\n  Database: ${resolved}`);
  console.log("\n  Try it out:");
  console.log(`    DB_PATH="${resolved}" ANTHROPIC_API_KEY=dummy ray bnpl`);
  console.log(`    DB_PATH="${resolved}" ANTHROPIC_API_KEY=dummy ray usage`);
  console.log(`    DB_PATH="${resolved}" ANTHROPIC_API_KEY=dummy ray consult "MacBook Pro upgrade" --price 2499 --category electronics --urgency high --bnpl --installments 4`);
  console.log(`    DB_PATH="${resolved}" ANTHROPIC_API_KEY=dummy ray friction`);

  db.close();
}

function seedSenseiState(db: Database.Database): void {
  createBnplPlan(db, {
    provider: "Affirm",
    merchant: "Wahoo",
    itemName: "Wahoo KICKR smart trainer",
    totalAmount: 899,
    remainingAmount: 674.25,
    installmentAmount: 224.75,
    installmentCount: 3,
    nextPaymentDate: isoDaysFromNow(5),
    frequencyDays: 30,
    purchaseDate: isoDaysFromNow(-25),
    note: "Winter training purchase; pressure overlaps rent week.",
  });

  createBnplPlan(db, {
    provider: "Klarna",
    merchant: "Arc'teryx",
    itemName: "Rain shell",
    totalAmount: 420,
    remainingAmount: 210,
    installmentAmount: 105,
    installmentCount: 2,
    nextPaymentDate: isoDaysFromNow(12),
    frequencyDays: 14,
    purchaseDate: isoDaysFromNow(-16),
    note: "Outdoor gear installment still open.",
  });

  createBnplPlan(db, {
    provider: "Afterpay",
    merchant: "Best Buy",
    itemName: "Noise-canceling headphones",
    totalAmount: 349,
    remainingAmount: 174.5,
    installmentAmount: 87.25,
    installmentCount: 2,
    nextPaymentDate: isoDaysFromNow(2),
    frequencyDays: 14,
    purchaseDate: isoDaysFromNow(-26),
    note: "Impulse tech purchase from last month.",
  });

  seedUsage(db);
  seedConsultations(db);
}

function seedUsage(db: Database.Database): void {
  for (let i = 0; i < 16; i++) {
    logAssetUsage(db, {
      assetName: "Gravel bike",
      category: "cycling",
      purchasePrice: i === 0 ? 2400 : undefined,
      usageMetric: "ride",
      quantity: 1,
      usedAt: isoDaysFromNow(-i * 8),
      note: i % 4 === 0 ? "Long weekend ride" : undefined,
    });
  }

  for (let i = 0; i < 12; i++) {
    logAssetUsage(db, {
      assetName: "Gravel bike",
      category: "cycling",
      usageMetric: "mile",
      quantity: i % 3 === 0 ? 42 : 27,
      usedAt: isoDaysFromNow(-i * 10),
    });
  }

  for (let i = 0; i < 5; i++) {
    logAssetUsage(db, {
      assetName: "Torque wrench",
      category: "tool",
      purchasePrice: i === 0 ? 180 : undefined,
      usageMetric: "project",
      quantity: 1,
      usedAt: isoDaysFromNow(-i * 37),
    });
  }

  for (let i = 0; i < 10; i++) {
    logAssetUsage(db, {
      assetName: "Figma Professional",
      category: "software",
      purchasePrice: i === 0 ? 144 : undefined,
      usageMetric: "hour",
      quantity: i % 2 === 0 ? 3 : 1.5,
      usedAt: isoDaysFromNow(-i * 9),
    });
  }
}

function seedConsultations(db: Database.Database): void {
  const concreteSaw = evaluatePurchase(db, {
    itemName: "Concrete saw",
    price: 900,
    category: "tool",
    urgency: "high",
    rentCost: 85,
    expectedUsesPerMonth: 0.05,
    expectedMonths: 12,
  });
  const concreteSawId = savePurchaseConsultation(db, concreteSaw);
  recordPurchaseDecision(db, concreteSawId, "rent", "Rented from Home Depot first; one weekend project did not justify owning it.");

  const macbook = evaluatePurchase(db, {
    itemName: "MacBook Pro upgrade",
    price: 2499,
    category: "electronics",
    urgency: "high",
    paymentMode: "bnpl",
    installmentCount: 4,
  });
  const macbookId = savePurchaseConsultation(db, macbook);
  recordPurchaseDecision(db, macbookId, "wait", "Keeping current laptop for another 48 hours and checking refurb pricing.");

  const radar = evaluatePurchase(db, {
    itemName: "Garmin Varia radar light",
    price: 149,
    category: "cycling",
    urgency: "low",
    expectedUsesPerMonth: 16,
    expectedMonths: 36,
  });
  savePurchaseConsultation(db, radar);

  const cashPriceCheck = getFrictionCommitments(db).find(
    commitment => commitment.consultationId === macbookId && commitment.type === "cash_price_check",
  );
  if (cashPriceCheck) {
    resolveFrictionCommitment(db, cashPriceCheck.id, "Would not buy today if BNPL were unavailable.");
  }
}

function count(db: Database.Database, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
