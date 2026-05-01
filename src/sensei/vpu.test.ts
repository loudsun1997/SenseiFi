import { describe, expect, it } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { getAssetVpu, getCategoryUsageSignal, logAssetUsage } from "./vpu.js";

type DB = InstanceType<typeof Database>;

function freshDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

describe("VPU tracking", () => {
  it("calculates cost per usage metric for an asset", () => {
    const db = freshDb();
    logAssetUsage(db, { assetName: "Gravel bike", category: "cycling", purchasePrice: 1200, usageMetric: "mile", quantity: 20, usedAt: "2026-01-01" });
    logAssetUsage(db, { assetName: "Gravel bike", category: "cycling", usageMetric: "mile", quantity: 30, usedAt: "2026-01-08" });

    const summary = getAssetVpu(db, "Gravel bike");
    expect(summary?.totalQuantity).toBe(50);
    expect(summary?.costPerUnit).toBe(24);
    expect(summary?.usageMetric).toBe("mile");
  });

  it("builds a category usage signal from recent usage", () => {
    const db = freshDb();
    logAssetUsage(db, { assetName: "Bike", category: "cycling", usageMetric: "ride", quantity: 4, usedAt: new Date().toISOString().slice(0, 10) });
    logAssetUsage(db, { assetName: "Trainer", category: "cycling", usageMetric: "ride", quantity: 6, usedAt: new Date().toISOString().slice(0, 10) });

    const signal = getCategoryUsageSignal(db, "cycling", "ride");
    expect(signal?.totalQuantity).toBe(10);
    expect(signal?.quantityPerMonth).toBe(10);
    expect(signal?.sampleSize).toBe(2);
  });
});
