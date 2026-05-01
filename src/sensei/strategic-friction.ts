import type Database from "libsql";
import type { PurchaseConsultResult } from "./purchase-consultant.js";

export type FrictionCommitmentStatus = "active" | "resolved" | "expired" | "dismissed";

export interface StrategicFrictionCommitment {
  id: number;
  consultationId: number;
  type: string;
  status: FrictionCommitmentStatus;
  dueAt: string;
  prompt: string;
  resolvedAt: string | null;
  resolution: string | null;
  itemName: string;
  price: number;
  recommendation: string;
}

export function createFrictionCommitments(db: Database.Database, consultationId: number, result: PurchaseConsultResult): number[] {
  if (result.recommendation === "buy") return [];

  const commitments = buildCommitments(result);
  const insert = db.prepare(`
    INSERT INTO strategic_friction_commitments (consultation_id, type, due_at, prompt)
    VALUES (?, ?, ?, ?)
  `);

  const create = db.transaction(() => {
    const ids: number[] = [];
    for (const commitment of commitments) {
      const info = insert.run(consultationId, commitment.type, commitment.dueAt, commitment.prompt);
      ids.push(Number(info.lastInsertRowid));
    }
    return ids;
  });

  return create();
}

export function getFrictionCommitments(db: Database.Database, options: {
  status?: FrictionCommitmentStatus | "all";
  dueWithinDays?: number;
} = {}): StrategicFrictionCommitment[] {
  const status = options.status ?? "active";
  const conditions: string[] = [];
  const params: any[] = [];

  if (status !== "all") {
    conditions.push("c.status = ?");
    params.push(status);
  }
  if (options.dueWithinDays !== undefined) {
    conditions.push("c.due_at <= datetime('now', ?)");
    params.push(`+${options.dueWithinDays} days`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT c.id, c.consultation_id, c.type, c.status, c.due_at, c.prompt,
           c.resolved_at, c.resolution, p.item_name, p.price, p.recommendation
    FROM strategic_friction_commitments c
    JOIN purchase_consultations p ON p.id = c.consultation_id
    ${where}
    ORDER BY c.due_at, c.id
  `).all(...params) as any[];

  return rows.map(mapCommitment);
}

export function resolveFrictionCommitment(db: Database.Database, commitmentId: number, resolution: string, status: FrictionCommitmentStatus = "resolved"): void {
  const info = db.prepare(`
    UPDATE strategic_friction_commitments
    SET status = ?, resolution = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(status, resolution, commitmentId);
  if (info.changes === 0) throw new Error(`Strategic friction commitment ${commitmentId} was not found.`);
}

function buildCommitments(result: PurchaseConsultResult): { type: string; dueAt: string; prompt: string }[] {
  const commitments: { type: string; dueAt: string; prompt: string }[] = [];
  const item = result.input.itemName;
  const price = formatMoney(result.input.price);

  if (result.recommendation === "wait" || result.recommendation === "skip") {
    commitments.push({
      type: "cooldown_48h",
      dueAt: dateTimeAfterHours(48),
      prompt: `48-hour check: do you still want ${item} at ${price}, or did the impulse fade?`,
    });
  }

  if (result.recommendation === "rent") {
    commitments.push({
      type: "rent_first",
      dueAt: dateTimeAfterHours(72),
      prompt: `Rent-first check: did renting or borrowing ${item} prove you would use it enough to buy?`,
    });
  }

  if (result.value.valuePerUse !== null && result.value.valuePerUse > 0 && result.recommendation !== "buy") {
    commitments.push({
      type: "usage_audit",
      dueAt: dateTimeAfterHours(24 * 14),
      prompt: `Usage audit: log real usage before buying ${item}; target a better cost per ${result.value.metric}.`,
    });
  }

  if (result.input.paymentMode === "bnpl") {
    commitments.push({
      type: "cash_price_check",
      dueAt: dateTimeAfterHours(24),
      prompt: `Cash-price check: would you still buy ${item} today if BNPL were unavailable?`,
    });
  }

  return commitments;
}

function mapCommitment(row: any): StrategicFrictionCommitment {
  return {
    id: row.id,
    consultationId: row.consultation_id,
    type: row.type,
    status: row.status,
    dueAt: row.due_at,
    prompt: row.prompt,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    itemName: row.item_name,
    price: row.price,
    recommendation: row.recommendation,
  };
}

function dateTimeAfterHours(hours: number): string {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

function formatMoney(value: number): string {
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
