import type Database from "libsql";
import { getBnplPressure } from "./bnpl.js";
import { createFrictionCommitments } from "./strategic-friction.js";
import { getCategoryUsageSignal } from "./vpu.js";

export type PurchaseRecommendation = "buy" | "wait" | "rent" | "skip";
export type PurchasePaymentMode = "cash" | "bnpl";
export type PurchaseUrgency = "low" | "normal" | "high";

export interface PurchaseConsultInput {
  itemName: string;
  price: number;
  category?: string;
  merchant?: string;
  paymentMode?: PurchasePaymentMode;
  urgency?: PurchaseUrgency;
  expectedUsesPerMonth?: number;
  expectedMonths?: number;
  rentCost?: number;
  installmentCount?: number;
  installmentAmount?: number;
  downPayment?: number;
  installmentEveryDays?: number;
}

export interface PurchaseConsultResult {
  input: {
    itemName: string;
    price: number;
    category: string | null;
    merchant: string | null;
    paymentMode: PurchasePaymentMode;
    urgency: PurchaseUrgency;
    expectedUsesPerMonth: number;
    expectedMonths: number;
  };
  recommendation: PurchaseRecommendation;
  utilityScore: number;
  scores: {
    liquidity: number;
    cashPressure: number;
    value: number;
    impulse: number;
  };
  liquidity: {
    cashOnHand: number;
    purchaseCashImpact: number;
    cashAfterPurchase: number;
    emergencyBufferMonthsAfterPurchase: number | null;
  };
  pressure: {
    currentBnpl30: number;
    currentBnpl60: number;
    currentBnpl90: number;
    candidate30: number;
    candidate60: number;
    candidate90: number;
    combined30: number;
    combined60: number;
    combined90: number;
  };
  value: {
    metric: string;
    expectedUses: number;
    valuePerUse: number | null;
    rentalBreakEvenUses: number | null;
    usageSource: "user" | "history" | "default";
  };
  savingsDelayDays: number | null;
  impulseGuard: string[];
  rationale: string[];
  confidence: "low" | "medium" | "high";
}

interface CategoryProfile {
  metric: string;
  defaultUsesPerMonth: number;
  defaultMonths: number;
  strongValuePerUse: number;
  weakValuePerUse: number;
}

const CATEGORY_PROFILES: Record<string, CategoryProfile> = {
  cycling: { metric: "ride", defaultUsesPerMonth: 8, defaultMonths: 36, strongValuePerUse: 5, weakValuePerUse: 18 },
  bike: { metric: "ride", defaultUsesPerMonth: 8, defaultMonths: 36, strongValuePerUse: 5, weakValuePerUse: 18 },
  fitness: { metric: "workout", defaultUsesPerMonth: 10, defaultMonths: 24, strongValuePerUse: 4, weakValuePerUse: 14 },
  subscription: { metric: "hour", defaultUsesPerMonth: 8, defaultMonths: 1, strongValuePerUse: 2, weakValuePerUse: 9 },
  software: { metric: "hour", defaultUsesPerMonth: 10, defaultMonths: 1, strongValuePerUse: 2, weakValuePerUse: 10 },
  tool: { metric: "project", defaultUsesPerMonth: 1, defaultMonths: 60, strongValuePerUse: 12, weakValuePerUse: 45 },
  electronics: { metric: "use", defaultUsesPerMonth: 12, defaultMonths: 24, strongValuePerUse: 3, weakValuePerUse: 15 },
  travel: { metric: "day", defaultUsesPerMonth: 6, defaultMonths: 1, strongValuePerUse: 80, weakValuePerUse: 250 },
};

const DEFAULT_PROFILE: CategoryProfile = {
  metric: "use",
  defaultUsesPerMonth: 4,
  defaultMonths: 12,
  strongValuePerUse: 5,
  weakValuePerUse: 25,
};

export function evaluatePurchase(db: Database.Database, raw: PurchaseConsultInput): PurchaseConsultResult {
  const input = normalizeInput(raw);
  const profile = getProfile(input.category);
  const usageSignal = getCategoryUsageSignal(db, input.category, profile.metric);
  const expectedUsesPerMonth = input.expectedUsesPerMonth ?? usageSignal?.quantityPerMonth ?? profile.defaultUsesPerMonth;
  const expectedMonths = input.expectedMonths ?? profile.defaultMonths;
  const expectedUses = Math.max(0, expectedUsesPerMonth * expectedMonths);
  const valuePerUse = expectedUses > 0 ? roundMoney(input.price / expectedUses) : null;
  const rentalBreakEvenUses = input.rentCost && input.rentCost > 0
    ? Math.ceil(input.price / input.rentCost)
    : null;

  const cashOnHand = getLiquidCash(db);
  const avgMonthlyOutflow = getAverageMonthlyOutflow(db);
  const avgMonthlySurplus = getAverageMonthlySurplus(db);
  const purchaseCashImpact = getPurchaseCashImpact(input);
  const cashAfterPurchase = roundMoney(cashOnHand - purchaseCashImpact);
  const emergencyBufferMonthsAfterPurchase = avgMonthlyOutflow > 0
    ? roundMoney(cashAfterPurchase / avgMonthlyOutflow)
    : null;

  const bnpl = getBnplPressure(db, { days: 90 });
  const current30 = windowAmount(bnpl, 30);
  const current60 = windowAmount(bnpl, 60);
  const current90 = windowAmount(bnpl, 90);
  const candidate30 = getCandidateInstallmentPressure(input, 30);
  const candidate60 = getCandidateInstallmentPressure(input, 60);
  const candidate90 = getCandidateInstallmentPressure(input, 90);

  const liquidityScore = scoreLiquidity(cashOnHand, cashAfterPurchase, avgMonthlyOutflow, input);
  const cashPressureScore = scoreCashPressure(cashOnHand, current30 + candidate30, current60 + candidate60, current90 + candidate90);
  const valueScore = scoreValue(valuePerUse, profile, rentalBreakEvenUses);
  const impulseScore = scoreImpulse(input, valuePerUse, profile);
  const utilityScore = clampScore(Math.round(
    liquidityScore * 0.34 +
    cashPressureScore * 0.26 +
    valueScore * 0.28 +
    impulseScore * 0.12
  ));
  const recommendation = chooseRecommendation(utilityScore, liquidityScore, cashPressureScore, valueScore, impulseScore, input);
  const savingsDelayDays = avgMonthlySurplus > 0
    ? Math.ceil(input.price / (avgMonthlySurplus / 30))
    : null;

  return {
    input: {
      itemName: input.itemName,
      price: input.price,
      category: input.category ?? null,
      merchant: input.merchant ?? null,
      paymentMode: input.paymentMode,
      urgency: input.urgency,
      expectedUsesPerMonth,
      expectedMonths,
    },
    recommendation,
    utilityScore,
    scores: {
      liquidity: liquidityScore,
      cashPressure: cashPressureScore,
      value: valueScore,
      impulse: impulseScore,
    },
    liquidity: {
      cashOnHand: roundMoney(cashOnHand),
      purchaseCashImpact,
      cashAfterPurchase,
      emergencyBufferMonthsAfterPurchase,
    },
    pressure: {
      currentBnpl30: current30,
      currentBnpl60: current60,
      currentBnpl90: current90,
      candidate30,
      candidate60,
      candidate90,
      combined30: roundMoney(current30 + candidate30),
      combined60: roundMoney(current60 + candidate60),
      combined90: roundMoney(current90 + candidate90),
    },
    value: {
      metric: profile.metric,
      expectedUses,
      valuePerUse,
      rentalBreakEvenUses,
      usageSource: input.expectedUsesPerMonth !== undefined ? "user" : usageSignal ? "history" : "default",
    },
    savingsDelayDays,
    impulseGuard: buildImpulseGuard(recommendation, input, profile, valuePerUse, rentalBreakEvenUses),
    rationale: buildRationale(cashAfterPurchase, emergencyBufferMonthsAfterPurchase, current30 + candidate30, valuePerUse, profile, savingsDelayDays),
    confidence: getConfidence(db),
  };
}

export function savePurchaseConsultation(db: Database.Database, result: PurchaseConsultResult): number {
  const info = db.prepare(`
    INSERT INTO purchase_consultations (
      item_name, merchant, category, price, payment_mode, urgency, expected_uses_per_month, expected_months,
      recommendation, utility_score, liquidity_score, cash_pressure_score, value_score, impulse_score,
      cash_on_hand, purchase_cash_impact, cash_after_purchase,
      bnpl_pressure_30, bnpl_pressure_60, bnpl_pressure_90,
      savings_delay_days, value_per_use, value_usage_source, impulse_guard_json, rationale_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.input.itemName,
    result.input.merchant,
    result.input.category,
    result.input.price,
    result.input.paymentMode,
    result.input.urgency,
    result.input.expectedUsesPerMonth,
    result.input.expectedMonths,
    result.recommendation,
    result.utilityScore,
    result.scores.liquidity,
    result.scores.cashPressure,
    result.scores.value,
    result.scores.impulse,
    result.liquidity.cashOnHand,
    result.liquidity.purchaseCashImpact,
    result.liquidity.cashAfterPurchase,
    result.pressure.combined30,
    result.pressure.combined60,
    result.pressure.combined90,
    result.savingsDelayDays,
    result.value.valuePerUse,
    result.value.usageSource,
    JSON.stringify(result.impulseGuard),
    JSON.stringify(result.rationale),
  );

  const id = Number(info.lastInsertRowid);
  createFrictionCommitments(db, id, result);
  return id;
}

export function recordPurchaseDecision(db: Database.Database, consultationId: number, decision: string, note?: string): void {
  const consult = db.prepare(`
    SELECT price, recommendation FROM purchase_consultations WHERE id = ?
  `).get(consultationId) as { price: number; recommendation: PurchaseRecommendation } | undefined;
  if (!consult) throw new Error(`Purchase consultation ${consultationId} was not found.`);

  const normalizedDecision = decision.trim().toLowerCase();
  const friction = scoreFrictionOutcome(normalizedDecision, consult.price);

  const record = db.transaction(() => {
    db.prepare(`
      INSERT INTO purchase_decisions (consultation_id, decision, note)
      VALUES (?, ?, ?)
    `).run(consultationId, decision, note ?? null);

    if (friction.points > 0 || friction.outcome !== "dismissed") {
      db.prepare(`
        INSERT INTO strategic_friction_events (consultation_id, action, outcome, points, amount_avoided, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        consultationId,
        normalizedDecision,
        friction.outcome,
        friction.points,
        friction.amountAvoided,
        note ?? null,
      );
    }
  });

  record();
}

function normalizeInput(input: PurchaseConsultInput): Required<Pick<PurchaseConsultInput, "itemName" | "price" | "paymentMode" | "urgency">> & PurchaseConsultInput {
  const itemName = input.itemName.trim();
  if (!itemName) throw new Error("Purchase item name is required.");
  if (!Number.isFinite(input.price) || input.price <= 0) throw new Error("Purchase price must be positive.");
  if (input.expectedUsesPerMonth !== undefined && input.expectedUsesPerMonth < 0) throw new Error("Expected uses per month must be non-negative.");
  if (input.expectedMonths !== undefined && input.expectedMonths < 0) throw new Error("Expected months must be non-negative.");
  if (input.rentCost !== undefined && input.rentCost < 0) throw new Error("Rent cost must be non-negative.");

  return {
    ...input,
    itemName,
    price: roundMoney(input.price),
    paymentMode: input.paymentMode ?? "cash",
    urgency: input.urgency ?? "normal",
  };
}

function getProfile(category?: string): CategoryProfile {
  if (!category) return DEFAULT_PROFILE;
  const normalized = category.toLowerCase().replace(/[^a-z]/g, "");
  return CATEGORY_PROFILES[normalized] ?? DEFAULT_PROFILE;
}

function getLiquidCash(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(available_balance, current_balance, 0)), 0) as total
    FROM accounts
    WHERE type = 'depository' AND hidden = 0
  `).get() as { total: number };
  return row.total || 0;
}

function getAverageMonthlyOutflow(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) / 3.0 as total
    FROM transactions
    WHERE amount > 0 AND date > date('now', '-90 days') AND pending = 0
    AND category NOT IN ('TRANSFER_OUT', 'TRANSFER_IN')
  `).get() as { total: number };
  return row.total || 0;
}

function getAverageMonthlySurplus(db: Database.Database): number {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount < 0 AND category NOT IN ('TRANSFER_IN', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT', 'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT') THEN ABS(amount) ELSE 0 END), 0) / 3.0 as income,
      COALESCE(SUM(CASE WHEN amount > 0 AND category NOT IN ('TRANSFER_OUT', 'TRANSFER_IN') THEN amount ELSE 0 END), 0) / 3.0 as outflow
    FROM transactions
    WHERE date > date('now', '-90 days') AND pending = 0
  `).get() as { income: number; outflow: number };
  return (row.income || 0) - (row.outflow || 0);
}

function getPurchaseCashImpact(input: ReturnType<typeof normalizeInput>): number {
  if (input.paymentMode === "cash") return input.price;
  const count = Math.max(1, Math.round(input.installmentCount ?? 4));
  return roundMoney(input.downPayment ?? input.installmentAmount ?? (input.price / count));
}

function getCandidateInstallmentPressure(input: ReturnType<typeof normalizeInput>, days: number): number {
  if (input.paymentMode === "cash") return days >= 30 ? input.price : input.price;
  const count = Math.max(1, Math.round(input.installmentCount ?? 4));
  const every = Math.max(1, Math.round(input.installmentEveryDays ?? 14));
  const first = roundMoney(input.downPayment ?? input.installmentAmount ?? (input.price / count));
  const amounts = splitInstallments(input.price, count, input.installmentAmount, first);
  let total = 0;
  for (let i = 0; i < amounts.length; i++) {
    const dueOffset = i === 0 ? 0 : every * i;
    if (dueOffset <= days) total += amounts[i];
  }
  return roundMoney(total);
}

function splitInstallments(total: number, count: number, fixedAmount?: number, firstAmount?: number): number[] {
  if (fixedAmount !== undefined) {
    const amounts = Array.from({ length: count }, () => roundMoney(fixedAmount));
    const diff = roundMoney(total - amounts.reduce((sum, amount) => sum + amount, 0));
    amounts[amounts.length - 1] = roundMoney(amounts[amounts.length - 1] + diff);
    return amounts;
  }
  const first = firstAmount ?? total / count;
  const restCount = Math.max(0, count - 1);
  if (restCount === 0) return [roundMoney(total)];
  const rest = roundMoney((total - first) / restCount);
  const amounts = [roundMoney(first), ...Array.from({ length: restCount }, () => rest)];
  const diff = roundMoney(total - amounts.reduce((sum, amount) => sum + amount, 0));
  amounts[amounts.length - 1] = roundMoney(amounts[amounts.length - 1] + diff);
  return amounts;
}

function windowAmount(pressure: ReturnType<typeof getBnplPressure>, days: number): number {
  return pressure.windows.find((w) => w.days === days)?.amount ?? 0;
}

function scoreLiquidity(cashOnHand: number, cashAfterPurchase: number, avgMonthlyOutflow: number, input: ReturnType<typeof normalizeInput>): number {
  if (cashOnHand <= 0) return 0;
  if (cashAfterPurchase < 0) return 15;
  const bufferMonths = avgMonthlyOutflow > 0 ? cashAfterPurchase / avgMonthlyOutflow : 2;
  let score = bufferMonths >= 3 ? 100 : bufferMonths >= 1 ? 70 + bufferMonths * 10 : 30 + bufferMonths * 35;
  if (input.paymentMode === "bnpl") score -= 8;
  return clampScore(score);
}

function scoreCashPressure(cashOnHand: number, pressure30: number, pressure60: number, pressure90: number): number {
  if (cashOnHand <= 0) return 0;
  const worstRatio = Math.max(pressure30 / cashOnHand, pressure60 / cashOnHand, pressure90 / cashOnHand);
  if (worstRatio <= 0.05) return 100;
  if (worstRatio <= 0.15) return 88;
  if (worstRatio <= 0.3) return 70;
  if (worstRatio <= 0.5) return 50;
  return 28;
}

function scoreValue(valuePerUse: number | null, profile: CategoryProfile, rentalBreakEvenUses: number | null): number {
  if (valuePerUse === null) return 40;
  let score: number;
  if (valuePerUse <= profile.strongValuePerUse) score = 100;
  else if (valuePerUse <= profile.weakValuePerUse) {
    const span = profile.weakValuePerUse - profile.strongValuePerUse;
    score = 100 - ((valuePerUse - profile.strongValuePerUse) / Math.max(1, span)) * 40;
  } else {
    score = 58 - Math.min(40, ((valuePerUse - profile.weakValuePerUse) / profile.weakValuePerUse) * 40);
  }
  if (rentalBreakEvenUses !== null && rentalBreakEvenUses > 10) score -= 8;
  return clampScore(score);
}

function scoreImpulse(input: ReturnType<typeof normalizeInput>, valuePerUse: number | null, profile: CategoryProfile): number {
  let score = input.urgency === "low" ? 92 : input.urgency === "normal" ? 72 : 45;
  if (input.paymentMode === "bnpl") score -= 14;
  if (input.price >= 500 && input.urgency === "high") score -= 10;
  if (valuePerUse !== null && valuePerUse > profile.weakValuePerUse) score -= 12;
  return clampScore(score);
}

function chooseRecommendation(
  utilityScore: number,
  liquidityScore: number,
  cashPressureScore: number,
  valueScore: number,
  impulseScore: number,
  input: ReturnType<typeof normalizeInput>,
): PurchaseRecommendation {
  if (liquidityScore < 30 || cashPressureScore < 30) return "skip";
  if (valueScore < 45 && impulseScore < 55) return input.rentCost ? "rent" : "skip";
  if (utilityScore >= 78 && impulseScore >= 55) return "buy";
  if (utilityScore >= 62 && valueScore >= 65) return input.rentCost && input.urgency === "high" ? "rent" : "wait";
  if (input.rentCost && valueScore >= 45) return "rent";
  return "wait";
}

function buildImpulseGuard(
  recommendation: PurchaseRecommendation,
  input: ReturnType<typeof normalizeInput>,
  profile: CategoryProfile,
  valuePerUse: number | null,
  rentalBreakEvenUses: number | null,
): string[] {
  const guard: string[] = [];
  if (recommendation === "buy") {
    guard.push("Buy only if the price is paid as planned and no savings transfer is skipped.");
    return guard;
  }
  guard.push("Wait 48 hours, then re-run the consult with the same price.");
  if (input.paymentMode === "bnpl") guard.push("Reprice this as a cash purchase; BNPL should not make the item feel smaller.");
  if (recommendation === "rent") guard.push(`Rent or borrow it first and log at least one ${profile.metric} before buying.`);
  if (rentalBreakEvenUses !== null) guard.push(`Rental break-even is about ${rentalBreakEvenUses} ${profile.metric}${rentalBreakEvenUses === 1 ? "" : "s"}.`);
  if (valuePerUse !== null && valuePerUse > profile.weakValuePerUse) guard.push(`Set a usage floor that gets this below $${profile.weakValuePerUse.toFixed(2)} per ${profile.metric}.`);
  if (recommendation === "skip") guard.push("Move the avoided spend into the top goal or highest-interest debt.");
  return guard;
}

function buildRationale(
  cashAfterPurchase: number,
  bufferMonths: number | null,
  pressure30: number,
  valuePerUse: number | null,
  profile: CategoryProfile,
  savingsDelayDays: number | null,
): string[] {
  const lines = [`Cash after purchase would be $${formatMoneyNumber(cashAfterPurchase)}.`];
  if (bufferMonths !== null) lines.push(`That leaves about ${bufferMonths.toFixed(1)} months of recent outflows as buffer.`);
  lines.push(`BNPL/installment pressure due in the next 30 days would be $${formatMoneyNumber(pressure30)}.`);
  if (valuePerUse !== null) lines.push(`Value forecast is $${valuePerUse.toFixed(2)} per ${profile.metric}.`);
  lines.push(savingsDelayDays === null
    ? "Recent cash flow does not show reliable surplus, so savings delay is unbounded."
    : `At recent surplus pace, this delays goals by about ${savingsDelayDays} day${savingsDelayDays === 1 ? "" : "s"}.`);
  return lines;
}

function scoreFrictionOutcome(decision: string, price: number): { outcome: "accepted" | "dismissed"; points: number; amountAvoided: number | null } {
  if (decision === "skip") return { outcome: "accepted", points: Math.max(10, Math.round(price / 10)), amountAvoided: price };
  if (decision === "wait") return { outcome: "accepted", points: Math.max(5, Math.round(price / 25)), amountAvoided: null };
  if (decision === "rent") return { outcome: "accepted", points: Math.max(5, Math.round(price / 30)), amountAvoided: null };
  return { outcome: "dismissed", points: 0, amountAvoided: null };
}

function getConfidence(db: Database.Database): "low" | "medium" | "high" {
  const accounts = db.prepare(`SELECT COUNT(*) as count FROM accounts WHERE hidden = 0`).get() as { count: number };
  const txns = db.prepare(`SELECT COUNT(*) as count FROM transactions`).get() as { count: number };
  if (accounts.count >= 2 && txns.count >= 90) return "high";
  if (accounts.count >= 1 && txns.count >= 20) return "medium";
  return "low";
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatMoneyNumber(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
