import type Database from "libsql";

export interface AssetUsageInput {
  assetName: string;
  category?: string;
  purchasePrice?: number;
  usageMetric?: string;
  quantity?: number;
  usedAt?: string;
  note?: string;
}

export interface AssetVpuSummary {
  assetName: string;
  category: string | null;
  usageMetric: string;
  purchasePrice: number | null;
  totalQuantity: number;
  useCount: number;
  costPerUnit: number | null;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

export interface CategoryUsageSignal {
  category: string;
  usageMetric: string;
  totalQuantity: number;
  activeMonths: number;
  quantityPerMonth: number;
  sampleSize: number;
}

export function logAssetUsage(db: Database.Database, input: AssetUsageInput): number {
  validateUsage(input);
  const info = db.prepare(`
    INSERT INTO asset_usage (asset_name, category, purchase_price, usage_metric, quantity, used_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.assetName.trim(),
    input.category?.trim() || null,
    input.purchasePrice ?? null,
    input.usageMetric?.trim() || "use",
    input.quantity ?? 1,
    input.usedAt ?? new Date().toISOString().slice(0, 10),
    input.note?.trim() || null,
  );
  return Number(info.lastInsertRowid);
}

export function getAssetVpu(db: Database.Database, assetName: string): AssetVpuSummary | null {
  const rows = db.prepare(`
    SELECT asset_name, category, purchase_price, usage_metric, quantity, used_at
    FROM asset_usage
    WHERE LOWER(asset_name) = LOWER(?)
    ORDER BY used_at
  `).all(assetName.trim()) as {
    asset_name: string;
    category: string | null;
    purchase_price: number | null;
    usage_metric: string;
    quantity: number;
    used_at: string;
  }[];

  if (rows.length === 0) return null;
  const totalQuantity = round(rows.reduce((sum, row) => sum + row.quantity, 0));
  const purchasePrice = rows.find(row => row.purchase_price != null)?.purchase_price ?? null;

  return {
    assetName: rows[0].asset_name,
    category: rows.find(row => row.category)?.category ?? null,
    usageMetric: rows[0].usage_metric,
    purchasePrice,
    totalQuantity,
    useCount: rows.length,
    costPerUnit: purchasePrice != null && totalQuantity > 0 ? roundMoney(purchasePrice / totalQuantity) : null,
    firstUsedAt: rows[0].used_at,
    lastUsedAt: rows[rows.length - 1].used_at,
  };
}

export function getRecentAssetVpu(db: Database.Database, limit = 10): AssetVpuSummary[] {
  const assets = db.prepare(`
    SELECT asset_name, MAX(used_at) as last_used
    FROM asset_usage
    GROUP BY asset_name
    ORDER BY last_used DESC
    LIMIT ?
  `).all(limit) as { asset_name: string }[];

  return assets
    .map(row => getAssetVpu(db, row.asset_name))
    .filter((summary): summary is AssetVpuSummary => summary !== null);
}

export function getCategoryUsageSignal(db: Database.Database, category?: string, usageMetric?: string): CategoryUsageSignal | null {
  if (!category) return null;
  const metricClause = usageMetric ? "AND usage_metric = ?" : "";
  const params = usageMetric ? [category, usageMetric] : [category];
  const rows = db.prepare(`
    SELECT quantity, used_at, usage_metric
    FROM asset_usage
    WHERE LOWER(category) = LOWER(?)
      ${metricClause}
      AND used_at >= date('now', '-180 days')
    ORDER BY used_at
  `).all(...params) as { quantity: number; used_at: string; usage_metric: string }[];

  if (rows.length === 0) return null;
  const totalQuantity = round(rows.reduce((sum, row) => sum + row.quantity, 0));
  const first = new Date(rows[0].used_at + "T00:00:00Z");
  const last = new Date(rows[rows.length - 1].used_at + "T00:00:00Z");
  const activeMonths = Math.max(1, monthSpan(first, last));

  return {
    category,
    usageMetric: usageMetric ?? rows[0].usage_metric,
    totalQuantity,
    activeMonths,
    quantityPerMonth: round(totalQuantity / activeMonths),
    sampleSize: rows.length,
  };
}

function validateUsage(input: AssetUsageInput): void {
  if (!input.assetName.trim()) throw new Error("Asset name is required.");
  if (input.purchasePrice !== undefined && (!Number.isFinite(input.purchasePrice) || input.purchasePrice <= 0)) {
    throw new Error("Purchase price must be positive.");
  }
  if (input.quantity !== undefined && (!Number.isFinite(input.quantity) || input.quantity <= 0)) {
    throw new Error("Usage quantity must be positive.");
  }
  if (input.usedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.usedAt)) {
    throw new Error("Usage date must be YYYY-MM-DD.");
  }
}

function monthSpan(first: Date, last: Date): number {
  const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + (last.getUTCMonth() - first.getUTCMonth()) + 1;
  return Math.max(1, months);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
