import { describe, it, expect } from "vitest";
import Database from "libsql";
import { migrate } from "./schema.js";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("migrate", () => {
  it("creates expected tables", () => {
    const db = freshDb();
    migrate(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r: any) => r.name);

    const expected = [
      "accounts",
      "achievements",
      "ai_audit_log",
      "asset_usage",
      "bnpl_installments",
      "bnpl_plans",
      "budgets",
      "conversation_history",
      "daily_scores",
      "financial_analysis_runs",
      "financial_insights",
      "goals",
      "holdings",
      "institutions",
      "liabilities",
      "liability_apr_terms",
      "memories",
      "milestones",
      "net_worth_history",
      "purchase_consultations",
      "purchase_decisions",
      "recategorization_rules",
      "recurring",
      "recurring_bills",
      "securities",
      "settings",
      "strategic_friction_commitments",
      "strategic_friction_events",
      "transactions",
    ];

    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it("is idempotent", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});
