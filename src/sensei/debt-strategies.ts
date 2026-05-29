export type DebtStrategy = "minimum" | "avalanche" | "snowball" | "custom";

export interface DebtInput {
  id: string;
  name: string;
  balance: number;
  aprPct: number;
  minPayment: number;
}

export interface DebtPayoffSummary {
  id: string;
  name: string;
  aprPct: number;
  startingBalance: number;
  paidPrincipal: number;
  paidInterest: number;
  payoffMonth: number | null;
}

export interface DebtStrategyResult {
  strategy: DebtStrategy;
  monthsToDebtFree: number | null;
  totalPaid: number;
  totalInterestPaid: number;
  debtFreeDate: string | null;
  payoffOrder: string[];
  perDebt: DebtPayoffSummary[];
  warnings: string[];
}

export interface CompareDebtStrategiesInput {
  debts: DebtInput[];
  extraMonthly?: number;
  maxMonths?: number;
  customOrder?: string[];
  includeMinimum?: boolean;
}

export interface CompareDebtStrategiesResult {
  baselineDate: string;
  strategies: DebtStrategyResult[];
}

interface StateDebt extends DebtInput {
  startingBalance: number;
  paidPrincipal: number;
  paidInterest: number;
  payoffMonth: number | null;
}

export function compareDebtPayoffStrategies(input: CompareDebtStrategiesInput): CompareDebtStrategiesResult {
  const normalized = normalizeInput(input);
  const strategies: DebtStrategy[] = [
    ...(normalized.includeMinimum ? ["minimum"] as const : []),
    "avalanche",
    "snowball",
    ...(normalized.customOrder.length > 0 ? ["custom"] as const : []),
  ];

  return {
    baselineDate: new Date().toISOString().slice(0, 10),
    strategies: strategies.map(strategy => runStrategy(normalized, strategy)),
  };
}

function runStrategy(input: Required<Pick<CompareDebtStrategiesInput, "extraMonthly" | "maxMonths" | "customOrder" | "includeMinimum">> & { debts: DebtInput[] }, strategy: DebtStrategy): DebtStrategyResult {
  const state: StateDebt[] = input.debts.map(d => ({
    ...d,
    balance: roundMoney(Math.max(0, d.balance)),
    startingBalance: roundMoney(Math.max(0, d.balance)),
    paidPrincipal: 0,
    paidInterest: 0,
    payoffMonth: null as number | null,
  }));
  const warnings: string[] = [];
  let totalPaid = 0;
  let totalInterestPaid = 0;
  let monthsToDebtFree: number | null = null;

  for (let month = 1; month <= input.maxMonths; month++) {
    const active = state.filter(d => d.balance > 0.005);
    if (active.length === 0) {
      monthsToDebtFree = month - 1;
      break;
    }

    const cycle = active.map(debt => {
      const monthlyRate = Math.max(0, debt.aprPct) / 100 / 12;
      const interest = roundMoney(debt.balance * monthlyRate);
      const statementBalance = roundMoney(debt.balance + interest);
      const minDue = Math.min(statementBalance, inferMinPayment(debt, statementBalance));
      return { debt, interest, statementBalance, minDue };
    });

    const minimumPool = roundMoney(cycle.reduce((sum, row) => sum + row.minDue, 0));
    let paymentPool = roundMoney(minimumPool + (strategy === "minimum" ? 0 : input.extraMonthly));

    for (const row of cycle) {
      const payment = Math.min(row.minDue, row.statementBalance);
      applyPayment(row.debt, payment, row.interest, month);
      totalPaid = roundMoney(totalPaid + payment);
      totalInterestPaid = roundMoney(totalInterestPaid + row.interest);
      paymentPool = roundMoney(paymentPool - payment);
    }

    if (paymentPool > 0.005) {
      const targets = prioritizedTargets(state, strategy, input.customOrder);
      for (const target of targets) {
        if (paymentPool <= 0.005) break;
        if (target.balance <= 0.005) continue;
        const extra = Math.min(paymentPool, target.balance);
        applyExtraPrincipal(target, extra, month);
        totalPaid = roundMoney(totalPaid + extra);
        paymentPool = roundMoney(paymentPool - extra);
      }
    }
  }

  if (monthsToDebtFree == null && state.every(d => d.balance <= 0.005)) {
    monthsToDebtFree = Math.max(...state.map(d => d.payoffMonth ?? 0));
  }
  if (monthsToDebtFree == null) {
    warnings.push(`Did not fully pay off within ${input.maxMonths} months.`);
  }

  const payoffOrder = [...state]
    .sort((a, b) => (a.payoffMonth ?? Number.MAX_SAFE_INTEGER) - (b.payoffMonth ?? Number.MAX_SAFE_INTEGER))
    .map(d => d.name);

  return {
    strategy,
    monthsToDebtFree,
    totalPaid: roundMoney(totalPaid),
    totalInterestPaid: roundMoney(totalInterestPaid),
    debtFreeDate: monthsToDebtFree == null ? null : addMonthsIso(new Date(), monthsToDebtFree).slice(0, 7),
    payoffOrder,
    perDebt: state.map(d => ({
      id: d.id,
      name: d.name,
      aprPct: roundPct(d.aprPct),
      startingBalance: d.startingBalance,
      paidPrincipal: roundMoney(d.paidPrincipal),
      paidInterest: roundMoney(d.paidInterest),
      payoffMonth: d.payoffMonth,
    })),
    warnings,
  };
}

function applyPayment(
  debt: {
    balance: number;
    paidPrincipal: number;
    paidInterest: number;
    payoffMonth: number | null;
  },
  payment: number,
  interest: number,
  month: number,
): void {
  const principal = Math.max(0, roundMoney(payment - interest));
  debt.paidInterest = roundMoney(debt.paidInterest + interest);
  debt.paidPrincipal = roundMoney(debt.paidPrincipal + principal);
  debt.balance = roundMoney(Math.max(0, debt.balance - principal));
  if (debt.balance <= 0.005 && debt.payoffMonth == null) {
    debt.balance = 0;
    debt.payoffMonth = month;
  }
}

function applyExtraPrincipal(
  debt: {
    balance: number;
    paidPrincipal: number;
    payoffMonth: number | null;
  },
  extra: number,
  month: number,
): void {
  debt.paidPrincipal = roundMoney(debt.paidPrincipal + extra);
  debt.balance = roundMoney(Math.max(0, debt.balance - extra));
  if (debt.balance <= 0.005 && debt.payoffMonth == null) {
    debt.balance = 0;
    debt.payoffMonth = month;
  }
}

function prioritizedTargets(
  debts: StateDebt[],
  strategy: DebtStrategy,
  customOrder: string[],
): StateDebt[] {
  const active = debts.filter(d => d.balance > 0.005);
  if (strategy === "snowball") {
    return active.sort((a, b) => a.balance - b.balance || b.aprPct - a.aprPct);
  }
  if (strategy === "custom") {
    const rank = new Map(customOrder.map((id, idx) => [id, idx]));
    return active.sort((a, b) => {
      const ar = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
      const br = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
      return ar - br || b.aprPct - a.aprPct || a.balance - b.balance;
    });
  }
  if (strategy === "minimum") return [];
  return active.sort((a, b) => b.aprPct - a.aprPct || a.balance - b.balance);
}

function inferMinPayment(debt: DebtInput, statementBalance: number): number {
  if (Number.isFinite(debt.minPayment) && debt.minPayment > 0) return roundMoney(debt.minPayment);
  const pct = statementBalance * 0.02;
  return roundMoney(Math.min(statementBalance, Math.max(25, pct)));
}

function normalizeInput(input: CompareDebtStrategiesInput): Required<Pick<CompareDebtStrategiesInput, "extraMonthly" | "maxMonths" | "customOrder" | "includeMinimum">> & { debts: DebtInput[] } {
  const debts = (input.debts || [])
    .map((debt, idx) => ({
      id: String(debt.id || `debt-${idx + 1}`),
      name: String(debt.name || `Debt ${idx + 1}`),
      balance: Number(debt.balance || 0),
      aprPct: Math.max(0, Number(debt.aprPct || 0)),
      minPayment: Math.max(0, Number(debt.minPayment || 0)),
    }))
    .filter(d => d.balance > 0);
  if (debts.length === 0) {
    throw new Error("At least one debt with positive balance is required.");
  }

  return {
    debts,
    extraMonthly: Math.max(0, Number(input.extraMonthly ?? 0)),
    maxMonths: Math.max(12, Math.round(Number(input.maxMonths ?? 600))),
    customOrder: (input.customOrder || []).map(String).filter(Boolean),
    includeMinimum: Boolean(input.includeMinimum),
  };
}

function addMonthsIso(base: Date, months: number): string {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}
