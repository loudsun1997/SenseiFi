import type BetterSqlite3 from "libsql";

type Database = BetterSqlite3.Database;

const MODEL_VERSION = "senseifi-analysis-v1";
const DAY_MS = 86_400_000;
const EXCLUDED_OUTFLOW_CATEGORIES = new Set([
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "LOAN_PAYMENTS",
  "LOAN_PAYMENTS_CAR_PAYMENT",
  "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
]);
const INCOME_EXCLUDED_CATEGORIES = new Set([
  "TRANSFER_IN",
  "LOAN_PAYMENTS",
  "LOAN_PAYMENTS_CAR_PAYMENT",
  "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
]);

export interface InsightCard {
  kind: string;
  severity: "info" | "watch" | "risk" | "positive";
  title: string;
  detail: string;
  metricLabel?: string;
  metricValue?: number;
  action?: string;
}

export interface FinancialAnalysis {
  modelVersion: string;
  generatedAt: string;
  inputWindow: { start: string | null; end: string };
  confidence: "low" | "medium" | "high";
  paycheckCycle: PaycheckCycle;
  cashFlowForecast: CashFlowForecast;
  retirementProjection: RetirementProjection;
  debtAvalanche: DebtAvalanche;
  futureAccountBalanceSimulation: BalanceSimulation;
  recurringObligationCalendar: RecurringObligationCalendar;
  scenarioSimulation: ScenarioSimulation;
  trueAffordability: TrueAffordability;
  taxAwarePlanning: TaxAwarePlanning;
  investmentAllocation: InvestmentAllocation;
  emergencyFundRunway: EmergencyFundRunway;
  paycheckPressureMap: PaycheckPressureMap;
  insights: InsightCard[];
}

interface PaycheckCycle {
  detected: boolean;
  cadenceDays: number | null;
  averagePaycheck: number;
  monthlyIncome: number;
  lastPaycheckDate: string | null;
  nextPaycheckDate: string | null;
  employerHint: string | null;
  confidence: "low" | "medium" | "high";
}

interface CashFlowForecast {
  monthlyIncome: number;
  monthlyFixedObligations: number;
  monthlyVariableSpend: number;
  monthlyNet: number;
  nextPaycheckDate: string | null;
  safeCashUntilNextPaycheck: number;
  projectedCash30: number;
  projectedCash60: number;
  projectedCash90: number;
}

interface RetirementProjection {
  currentInvestments: number;
  monthlyContributionEstimate: number;
  assumedAnnualReturnPct: number;
  projected10Year: number;
  projected20Year: number;
  projected30Year: number;
  note: string;
}

interface DebtAvalanche {
  totalDebt: number;
  monthlyMinimums: number;
  estimatedMonthlySurplusForDebt: number;
  payoffOrder: DebtPlan[];
  note: string;
}

interface DebtPlan {
  accountName: string;
  type: string;
  balance: number;
  apr: number;
  minimumPayment: number;
  priority: number;
}

interface BalanceSimulation {
  startingCash: number;
  days: number;
  lowestProjectedCash: number;
  lowestProjectedCashDate: string;
  projectedEndCash: number;
  points: BalancePoint[];
}

interface BalancePoint {
  date: string;
  cash: number;
  income: number;
  obligations: number;
  variableSpend: number;
}

interface RecurringObligationCalendar {
  next30Days: number;
  next60Days: number;
  next90Days: number;
  obligations: Obligation[];
}

interface Obligation {
  date: string;
  name: string;
  amount: number;
  source: string;
  confidence: "low" | "medium" | "high";
}

interface ScenarioSimulation {
  scenarios: ScenarioResult[];
}

interface ScenarioResult {
  name: string;
  projectedCash30: number;
  projectedCash90: number;
  affordabilityImpact: number;
  pressure: "low" | "medium" | "high";
}

interface TrueAffordability {
  safeToSpendToday: number;
  safeToSpendUntilNextPaycheck: number;
  required30DayReserve: number;
  affordabilityBand: "tight" | "cautious" | "healthy";
  largestPurchaseWithoutPressure: number;
  note: string;
}

interface TaxAwarePlanning {
  estimatedAnnualGrossIncome: number;
  estimatedFederalAndFicaTax: number;
  estimatedEffectiveRatePct: number;
  pretaxContributionOpportunity: number;
  sideIncomeTaxReserve: number;
  note: string;
}

interface InvestmentAllocation {
  totalInvested: number;
  allocation: { label: string; amount: number; pct: number }[];
  concentrationWarnings: string[];
  note: string;
}

interface EmergencyFundRunway {
  cash: number;
  essentialMonthlySpend: number;
  runwayMonths: number;
  targetThreeMonths: number;
  targetSixMonths: number;
  gapToThreeMonths: number;
  gapToSixMonths: number;
}

interface PaycheckPressureMap {
  periods: PressurePeriod[];
}

interface PressurePeriod {
  startDate: string;
  endDate: string;
  startingCash: number;
  income: number;
  obligations: number;
  variableSpend: number;
  endingCash: number;
  pressure: "low" | "medium" | "high";
}

interface Txn {
  transaction_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  subcategory: string | null;
}

export function runFinancialAnalysis(db: Database): FinancialAnalysis {
  const today = isoDate(new Date());
  const oldest = db.prepare(`SELECT MIN(date) as date FROM transactions`).get() as { date: string | null };
  const run = db.prepare(`
    INSERT INTO financial_analysis_runs (model_version, status, input_window_start, input_window_end)
    VALUES (?, 'running', ?, ?)
  `).run(MODEL_VERSION, oldest.date, today);
  const runId = Number(run.lastInsertRowid);

  try {
    const analysis = computeFinancialAnalysis(db, today, oldest.date);
    const writeInsight = db.prepare(`
      INSERT INTO financial_insights
        (run_id, kind, severity, title, detail, metric_label, metric_value, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE financial_analysis_runs
        SET status = 'complete', completed_at = datetime('now'), result_json = ?
        WHERE id = ?
      `).run(JSON.stringify(analysis), runId);
      for (const insight of analysis.insights) {
        writeInsight.run(
          runId,
          insight.kind,
          insight.severity,
          insight.title,
          insight.detail,
          insight.metricLabel ?? null,
          insight.metricValue ?? null,
          insight.action ?? null,
        );
      }
    });
    tx();
    return analysis;
  } catch (error: any) {
    db.prepare(`
      UPDATE financial_analysis_runs
      SET status = 'failed', completed_at = datetime('now'), error = ?
      WHERE id = ?
    `).run(error.message || "Analysis failed", runId);
    throw error;
  }
}

export function getLatestFinancialAnalysis(db: Database): FinancialAnalysis | null {
  const row = db.prepare(`
    SELECT result_json FROM financial_analysis_runs
    WHERE status = 'complete' AND result_json IS NOT NULL
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `).get() as { result_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as FinancialAnalysis;
  } catch {
    return null;
  }
}

export function computeFinancialAnalysis(db: Database, today = isoDate(new Date()), windowStart: string | null = null): FinancialAnalysis {
  const transactions = getTransactions(db);
  const cash = sumRows(db.prepare(`
    SELECT COALESCE(SUM(current_balance), 0) as total FROM accounts
    WHERE hidden = 0 AND type = 'depository'
  `).get());
  const investmentBalance = sumRows(db.prepare(`
    SELECT COALESCE(SUM(current_balance), 0) as total FROM accounts
    WHERE hidden = 0 AND type = 'investment'
  `).get());

  const incomeTxns = transactions.filter(isIncomeTxn).sort(byDateAsc);
  const paycheckTxns = selectPaycheckTransactions(incomeTxns);
  const outflowTxns = transactions.filter(isSpendingTxn);
  const monthlyIncome = avgMonthlyIncome(incomeTxns, today);
  const monthlyOutflow = avgMonthlyOutflow(outflowTxns, today);
  const essentialSpend = avgMonthlyOutflow(outflowTxns.filter(isEssentialTxn), today) || monthlyOutflow * 0.65;
  const paycheckCycle = buildPaycheckCycle(paycheckTxns, monthlyIncome, today);
  const obligations = buildObligationCalendar(db, today, paycheckCycle);
  const fixed30 = sumDue(obligations, today, 30);
  const fixed60 = sumDue(obligations, today, 60);
  const fixed90 = sumDue(obligations, today, 90);
  const monthlyFixed = Math.max(fixed30, obligations.obligations.reduce((s, o) => s + o.amount, 0) / 3);
  const monthlyVariableSpend = Math.max(0, monthlyOutflow - monthlyFixed);
  const variableDailySpend = monthlyVariableSpend / 30;
  const simulation = simulateBalances(cash, paycheckCycle, obligations.obligations, variableDailySpend, today, 90);
  const nextPaycheckCash = projectedCashByDate(simulation.points, paycheckCycle.nextPaycheckDate);
  const affordability = buildAffordability(cash, fixed30, monthlyVariableSpend, essentialSpend, nextPaycheckCash);
  const cashFlowForecast: CashFlowForecast = {
    monthlyIncome,
    monthlyFixedObligations: roundMoney(monthlyFixed),
    monthlyVariableSpend: roundMoney(monthlyVariableSpend),
    monthlyNet: roundMoney(monthlyIncome - monthlyFixed - monthlyVariableSpend),
    nextPaycheckDate: paycheckCycle.nextPaycheckDate,
    safeCashUntilNextPaycheck: roundMoney(nextPaycheckCash),
    projectedCash30: cashAtDay(simulation.points, 30),
    projectedCash60: cashAtDay(simulation.points, 60),
    projectedCash90: cashAtDay(simulation.points, 90),
  };
  const debtAvalanche = buildDebtAvalanche(db, monthlyIncome, monthlyOutflow, today);
  const retirementProjection = buildRetirementProjection(db, investmentBalance, monthlyIncome, monthlyOutflow);
  const scenarioSimulation = buildScenarios(simulation, fixed30, monthlyVariableSpend);
  const taxAwarePlanning = buildTaxPlanning(incomeTxns, monthlyIncome);
  const investmentAllocation = buildInvestmentAllocation(db, investmentBalance);
  const emergencyFundRunway = buildEmergencyFund(cash, essentialSpend);
  const paycheckPressureMap = buildPressureMap(cash, paycheckCycle, obligations.obligations, variableDailySpend, today);
  const insights = buildInsights({
    cash,
    cashFlowForecast,
    affordability,
    emergencyFundRunway,
    debtAvalanche,
    retirementProjection,
    obligations,
    investmentAllocation,
    paycheckPressureMap,
  });
  const historyDays = windowStart ? Math.round((parseDate(today).getTime() - parseDate(windowStart).getTime()) / DAY_MS) : 0;

  return {
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    inputWindow: { start: windowStart, end: today },
    confidence: historyDays >= 75 && incomeTxns.length >= 3 ? "high" : historyDays >= 30 ? "medium" : "low",
    paycheckCycle,
    cashFlowForecast,
    retirementProjection,
    debtAvalanche,
    futureAccountBalanceSimulation: simulation,
    recurringObligationCalendar: obligations,
    scenarioSimulation,
    trueAffordability: affordability,
    taxAwarePlanning,
    investmentAllocation,
    emergencyFundRunway,
    paycheckPressureMap,
    insights,
  };
}

function getTransactions(db: Database): Txn[] {
  return db.prepare(`
    SELECT transaction_id, amount, date, name, merchant_name, category, subcategory
    FROM transactions
    WHERE pending = 0
    ORDER BY date ASC
  `).all() as Txn[];
}

function buildPaycheckCycle(incomeTxns: Txn[], monthlyIncome: number, today: string): PaycheckCycle {
  if (incomeTxns.length === 0) {
    return {
      detected: false,
      cadenceDays: null,
      averagePaycheck: 0,
      monthlyIncome,
      lastPaycheckDate: null,
      nextPaycheckDate: null,
      employerHint: null,
      confidence: "low",
    };
  }

  const dates = incomeTxns.map(t => t.date).sort();
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween(dates[i - 1], dates[i]);
    if (gap >= 5 && gap <= 45) gaps.push(gap);
  }
  const cadence = normalizeCadence(median(gaps) || Math.round(30 / Math.max(1, incomeTxns.length / 3)));
  const last = dates[dates.length - 1];
  const next = addDaysUntilFuture(last, cadence, today);
  const employer = mostCommon(incomeTxns.map(t => t.merchant_name || t.name));

  return {
    detected: true,
    cadenceDays: cadence,
    averagePaycheck: roundMoney(Math.max(
      incomeTxns.reduce((s, t) => s + Math.abs(t.amount), 0) / incomeTxns.length,
      monthlyIncome > 0 ? monthlyIncome / (30 / cadence) : 0,
    )),
    monthlyIncome,
    lastPaycheckDate: last,
    nextPaycheckDate: next,
    employerHint: employer,
    confidence: incomeTxns.length >= 4 && gaps.length >= 2 ? "high" : incomeTxns.length >= 2 ? "medium" : "low",
  };
}

function buildObligationCalendar(db: Database, today: string, paycheckCycle: PaycheckCycle): RecurringObligationCalendar {
  const obligations: Obligation[] = [];
  const recurring = db.prepare(`
    SELECT merchant_name, description, frequency, avg_amount, last_date, stream_type, status
    FROM recurring
    WHERE is_active = 1 AND stream_type = 'outflow'
  `).all() as any[];

  for (const r of recurring) {
    const every = frequencyDays(r.frequency);
    const anchor = r.last_date || today;
    for (const date of repeatDates(anchor, every, today, 90)) {
      obligations.push({
        date,
        name: r.merchant_name || r.description || "Recurring obligation",
        amount: roundMoney(Math.abs(r.avg_amount || 0)),
        source: "recurring",
        confidence: r.status === "MATURE" ? "high" : "medium",
      });
    }
  }

  const bills = db.prepare(`SELECT name, amount, day_of_month, type FROM recurring_bills`).all() as any[];
  for (const bill of bills) {
    if (!bill.day_of_month) continue;
    for (const date of monthlyDates(Number(bill.day_of_month), today, 90)) {
      obligations.push({
        date,
        name: bill.name,
        amount: roundMoney(Math.abs(bill.amount || 0)),
        source: bill.type || "bill",
        confidence: "high",
      });
    }
  }

  const liabilities = db.prepare(`
    SELECT a.name, a.type, l.minimum_payment, l.next_payment_due
    FROM liabilities l
    JOIN accounts a ON a.account_id = l.account_id
    WHERE l.minimum_payment IS NOT NULL AND l.minimum_payment > 0
  `).all() as any[];
  for (const debt of liabilities) {
    const anchor = debt.next_payment_due || nextMonthlyAnchor(today, 1);
    for (const date of repeatDates(anchor, 30, today, 90)) {
      obligations.push({
        date,
        name: `${debt.name} minimum payment`,
        amount: roundMoney(Math.abs(debt.minimum_payment)),
        source: "debt",
        confidence: debt.next_payment_due ? "high" : "medium",
      });
    }
  }

  const installments = db.prepare(`
    SELECT p.provider, p.item_name, i.amount, i.due_date
    FROM bnpl_installments i
    JOIN bnpl_plans p ON p.id = i.plan_id
    WHERE i.status = 'scheduled' AND i.due_date BETWEEN ? AND date(?, '+90 days')
  `).all(today, today) as any[];
  for (const row of installments) {
    obligations.push({
      date: row.due_date,
      name: `${row.provider || "BNPL"}: ${row.item_name}`,
      amount: roundMoney(Math.abs(row.amount || 0)),
      source: "bnpl",
      confidence: "high",
    });
  }

  if (paycheckCycle.nextPaycheckDate) {
    obligations.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  }

  return {
    next30Days: roundMoney(sumDue({ obligations } as RecurringObligationCalendar, today, 30)),
    next60Days: roundMoney(sumDue({ obligations } as RecurringObligationCalendar, today, 60)),
    next90Days: roundMoney(sumDue({ obligations } as RecurringObligationCalendar, today, 90)),
    obligations: obligations.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount).slice(0, 80),
  };
}

function simulateBalances(
  startingCash: number,
  paycheckCycle: PaycheckCycle,
  obligations: Obligation[],
  variableDailySpend: number,
  today: string,
  days: number,
): BalanceSimulation {
  const points: BalancePoint[] = [];
  let cash = startingCash;
  const paycheckDates = paycheckCycle.detected && paycheckCycle.cadenceDays && paycheckCycle.lastPaycheckDate
    ? new Set(repeatDates(paycheckCycle.lastPaycheckDate, paycheckCycle.cadenceDays, today, days))
    : new Set<string>();
  let lowestProjectedCash = startingCash;
  let lowestProjectedCashDate = today;

  for (let day = 1; day <= days; day++) {
    const date = addDays(today, day);
    const income = paycheckDates.has(date) ? paycheckCycle.averagePaycheck : 0;
    const due = obligations.filter(o => o.date === date).reduce((s, o) => s + o.amount, 0);
    const variable = variableDailySpend;
    cash = roundMoney(cash + income - due - variable);
    if (cash < lowestProjectedCash) {
      lowestProjectedCash = cash;
      lowestProjectedCashDate = date;
    }
    points.push({ date, cash, income: roundMoney(income), obligations: roundMoney(due), variableSpend: roundMoney(variable) });
  }

  return {
    startingCash: roundMoney(startingCash),
    days,
    lowestProjectedCash: roundMoney(lowestProjectedCash),
    lowestProjectedCashDate,
    projectedEndCash: points.length ? points[points.length - 1].cash : roundMoney(startingCash),
    points,
  };
}

function buildDebtAvalanche(db: Database, monthlyIncome: number, monthlyOutflow: number, today: string): DebtAvalanche {
  const debts = db.prepare(`
    SELECT a.name, a.type, a.subtype, a.current_balance, a.balance_limit,
           l.interest_rate, l.minimum_payment,
           t.promo_apr, t.promo_start_date, t.promo_end_date, t.post_promo_apr, t.enabled
    FROM accounts a
    LEFT JOIN liabilities l ON l.account_id = a.account_id
    LEFT JOIN liability_apr_terms t ON t.account_id = a.account_id
    WHERE a.hidden = 0 AND a.type IN ('credit', 'loan') AND COALESCE(a.current_balance, 0) > 0
  `).all() as any[];
  const plans = debts.map((d, index) => {
    const balance = Number(d.current_balance || 0);
    const apr = inferApr(d, today);
    const minimum = Number(d.minimum_payment || inferMinimum(d, balance));
    return {
      accountName: d.name,
      type: d.subtype || d.type,
      balance: roundMoney(balance),
      apr,
      minimumPayment: roundMoney(minimum),
      priority: index + 1,
    };
  }).sort((a, b) => b.apr - a.apr || b.balance - a.balance)
    .map((d, index) => ({ ...d, priority: index + 1 }));
  const monthlyMinimums = plans.reduce((s, d) => s + d.minimumPayment, 0);
  const surplus = Math.max(0, monthlyIncome - monthlyOutflow - monthlyMinimums);

  return {
    totalDebt: roundMoney(plans.reduce((s, d) => s + d.balance, 0)),
    monthlyMinimums: roundMoney(monthlyMinimums),
    estimatedMonthlySurplusForDebt: roundMoney(surplus),
    payoffOrder: plans,
    note: plans.length
      ? "Avalanche sends extra cash to the highest APR debt first while maintaining minimums on every other debt."
      : "No active debts were found in linked accounts.",
  };
}

function buildRetirementProjection(db: Database, investmentBalance: number, monthlyIncome: number, monthlyOutflow: number): RetirementProjection {
  const contribution = estimateMonthlyInvestmentContribution(db, monthlyIncome, monthlyOutflow);
  const annualReturn = 7;
  return {
    currentInvestments: roundMoney(investmentBalance),
    monthlyContributionEstimate: roundMoney(contribution),
    assumedAnnualReturnPct: annualReturn,
    projected10Year: roundMoney(futureValue(investmentBalance, contribution, 10, annualReturn)),
    projected20Year: roundMoney(futureValue(investmentBalance, contribution, 20, annualReturn)),
    projected30Year: roundMoney(futureValue(investmentBalance, contribution, 30, annualReturn)),
    note: "Projection uses a 7% nominal annual return before taxes and inflation. Add salary, tax bracket, retirement account limits, and target retirement age later for a full plan.",
  };
}

function buildAffordability(
  cash: number,
  fixed30: number,
  monthlyVariableSpend: number,
  essentialMonthlySpend: number,
  projectedNextPaycheckCash: number,
): TrueAffordability {
  const requiredReserve = fixed30 + monthlyVariableSpend + essentialMonthlySpend;
  const safeToday = Math.max(0, cash - requiredReserve);
  const safeUntilPaycheck = Math.max(0, projectedNextPaycheckCash - essentialMonthlySpend / 2);
  const largest = Math.max(0, Math.min(safeToday, safeUntilPaycheck));
  const band = largest < 100 ? "tight" : largest < 750 ? "cautious" : "healthy";
  return {
    safeToSpendToday: roundMoney(safeToday),
    safeToSpendUntilNextPaycheck: roundMoney(safeUntilPaycheck),
    required30DayReserve: roundMoney(requiredReserve),
    affordabilityBand: band,
    largestPurchaseWithoutPressure: roundMoney(largest),
    note: "True affordability reserves known obligations, normal variable spend, and an emergency cushion before calling cash spendable.",
  };
}

function buildScenarios(simulation: BalanceSimulation, fixed30: number, monthlyVariableSpend: number): ScenarioSimulation {
  const base30 = cashAtDay(simulation.points, 30);
  const base90 = cashAtDay(simulation.points, 90);
  const scenarios = [
    { name: "$500 purchase today", delta30: -500, delta90: -500 },
    { name: "$300/mo new obligation", delta30: -300, delta90: -900 },
    { name: "10% lower income for 90 days", delta30: -monthlyVariableSpend * 0.35, delta90: -monthlyVariableSpend },
    { name: "Cut discretionary spending 15%", delta30: monthlyVariableSpend * 0.15, delta90: monthlyVariableSpend * 0.45 },
  ].map(s => {
    const projectedCash30 = roundMoney(base30 + s.delta30);
    const projectedCash90 = roundMoney(base90 + s.delta90);
    return {
      name: s.name,
      projectedCash30,
      projectedCash90,
      affordabilityImpact: roundMoney(s.delta30),
      pressure: pressureFromCash(projectedCash30, fixed30),
    };
  });
  return { scenarios };
}

function buildTaxPlanning(incomeTxns: Txn[], monthlyIncome: number): TaxAwarePlanning {
  const annual = monthlyIncome * 12;
  const federalRate = annual > 190_000 ? 0.24 : annual > 100_000 ? 0.22 : annual > 50_000 ? 0.16 : 0.12;
  const fica = Math.min(annual, 168_600) * 0.0765;
  const tax = annual * federalRate + fica;
  const sideIncome = incomeTxns
    .filter(t => !/payroll|paycheck|salary|direct dep/i.test(`${t.name} ${t.merchant_name || ""}`))
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  return {
    estimatedAnnualGrossIncome: roundMoney(annual),
    estimatedFederalAndFicaTax: roundMoney(tax),
    estimatedEffectiveRatePct: annual > 0 ? roundPct((tax / annual) * 100) : 0,
    pretaxContributionOpportunity: roundMoney(Math.min(23_000, Math.max(0, annual * 0.12))),
    sideIncomeTaxReserve: roundMoney(sideIncome * 0.28),
    note: "Tax-aware planning is an estimate from cashflow only. It does not know filing status, deductions, state tax, RSUs, or employer plan limits yet.",
  };
}

function buildInvestmentAllocation(db: Database, investmentBalance: number): InvestmentAllocation {
  const holdings = db.prepare(`
    SELECT COALESCE(s.type, 'unknown') as type, COALESCE(h.value, 0) as value, s.name, s.ticker
    FROM holdings h
    LEFT JOIN securities s ON s.security_id = h.security_id
    WHERE COALESCE(h.value, 0) > 0
  `).all() as any[];
  const buckets = new Map<string, number>();
  if (holdings.length > 0) {
    for (const h of holdings) {
      const label = allocationLabel(h.type, `${h.name || ""} ${h.ticker || ""}`);
      buckets.set(label, (buckets.get(label) || 0) + Number(h.value || 0));
    }
  } else if (investmentBalance > 0) {
    buckets.set("Unclassified investments", investmentBalance);
  }
  const total = Array.from(buckets.values()).reduce((s, v) => s + v, 0);
  const allocation = Array.from(buckets.entries())
    .map(([label, amount]) => ({ label, amount: roundMoney(amount), pct: total > 0 ? roundPct((amount / total) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount);
  const concentrationWarnings = allocation.filter(a => a.pct >= 60).map(a => `${a.label} is ${a.pct}% of classified investments.`);
  return {
    totalInvested: roundMoney(total),
    allocation,
    concentrationWarnings,
    note: holdings.length ? "Allocation is based on synced holdings and security types." : "Holdings-level allocation is not available yet; linking brokerage holdings improves this model.",
  };
}

function buildEmergencyFund(cash: number, essentialMonthlySpend: number): EmergencyFundRunway {
  const three = essentialMonthlySpend * 3;
  const six = essentialMonthlySpend * 6;
  return {
    cash: roundMoney(cash),
    essentialMonthlySpend: roundMoney(essentialMonthlySpend),
    runwayMonths: essentialMonthlySpend > 0 ? roundPct(cash / essentialMonthlySpend) : 0,
    targetThreeMonths: roundMoney(three),
    targetSixMonths: roundMoney(six),
    gapToThreeMonths: roundMoney(Math.max(0, three - cash)),
    gapToSixMonths: roundMoney(Math.max(0, six - cash)),
  };
}

function buildPressureMap(
  cash: number,
  paycheckCycle: PaycheckCycle,
  obligations: Obligation[],
  variableDailySpend: number,
  today: string,
): PaycheckPressureMap {
  const cadence = paycheckCycle.cadenceDays || 14;
  const starts = paycheckCycle.nextPaycheckDate
    ? [today, paycheckCycle.nextPaycheckDate, addDays(paycheckCycle.nextPaycheckDate, cadence), addDays(paycheckCycle.nextPaycheckDate, cadence * 2)]
    : [today, addDays(today, 14), addDays(today, 28), addDays(today, 42)];
  let runningCash = cash;
  const periods: PressurePeriod[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const startDate = starts[i];
    const endDate = addDays(starts[i + 1], -1);
    const days = Math.max(1, daysBetween(startDate, endDate) + 1);
    const income = i === 0 ? 0 : paycheckCycle.averagePaycheck;
    const due = obligations
      .filter(o => o.date >= startDate && o.date <= endDate)
      .reduce((s, o) => s + o.amount, 0);
    const variableSpend = variableDailySpend * days;
    const startingCash = runningCash;
    runningCash = roundMoney(runningCash + income - due - variableSpend);
    periods.push({
      startDate,
      endDate,
      startingCash: roundMoney(startingCash),
      income: roundMoney(income),
      obligations: roundMoney(due),
      variableSpend: roundMoney(variableSpend),
      endingCash: runningCash,
      pressure: pressureFromCash(runningCash, due + variableSpend),
    });
  }
  return { periods };
}

function buildInsights(input: {
  cash: number;
  cashFlowForecast: CashFlowForecast;
  affordability: TrueAffordability;
  emergencyFundRunway: EmergencyFundRunway;
  debtAvalanche: DebtAvalanche;
  retirementProjection: RetirementProjection;
  obligations: RecurringObligationCalendar;
  investmentAllocation: InvestmentAllocation;
  paycheckPressureMap: PaycheckPressureMap;
}): InsightCard[] {
  const insights: InsightCard[] = [];
  insights.push({
    kind: "affordability",
    severity: input.affordability.affordabilityBand === "tight" ? "risk" : input.affordability.affordabilityBand === "cautious" ? "watch" : "positive",
    title: `True affordability is ${input.affordability.affordabilityBand}`,
    detail: `After reserving obligations and baseline spend, estimated safe spend today is ${money(input.affordability.safeToSpendToday)}.`,
    metricLabel: "safe_to_spend_today",
    metricValue: input.affordability.safeToSpendToday,
    action: input.affordability.affordabilityBand === "tight" ? "Delay nonessential purchases until the next paycheck clears." : "Use this as the top-line purchase guardrail.",
  });
  if (input.emergencyFundRunway.runwayMonths < 3) {
    insights.push({
      kind: "emergency_fund",
      severity: "risk",
      title: "Emergency runway is under three months",
      detail: `Current cash covers about ${input.emergencyFundRunway.runwayMonths} months of essential spend.`,
      metricLabel: "runway_months",
      metricValue: input.emergencyFundRunway.runwayMonths,
      action: `Build ${money(input.emergencyFundRunway.gapToThreeMonths)} more cash to reach three months.`,
    });
  }
  if (input.obligations.next30Days > input.cash * 0.5 && input.obligations.next30Days > 0) {
    insights.push({
      kind: "cash_pressure",
      severity: "watch",
      title: "Upcoming obligations are heavy relative to cash",
      detail: `${money(input.obligations.next30Days)} is due in the next 30 days.`,
      metricLabel: "obligations_30d",
      metricValue: input.obligations.next30Days,
      action: "Use the obligation calendar before making large discretionary purchases.",
    });
  }
  const firstHigh = input.paycheckPressureMap.periods.find(p => p.pressure === "high");
  if (firstHigh) {
    insights.push({
      kind: "paycheck_pressure",
      severity: "risk",
      title: "A paycheck window is projected tight",
      detail: `${firstHigh.startDate} to ${firstHigh.endDate} projects ending cash of ${money(firstHigh.endingCash)}.`,
      metricLabel: "ending_cash",
      metricValue: firstHigh.endingCash,
      action: "Move or reduce discretionary spend before that window.",
    });
  }
  if (input.debtAvalanche.payoffOrder.length > 0) {
    const top = input.debtAvalanche.payoffOrder[0];
    insights.push({
      kind: "debt_avalanche",
      severity: top.apr >= 18 ? "risk" : "info",
      title: `Avalanche target: ${top.accountName}`,
      detail: `${top.accountName} has the highest estimated APR at ${top.apr}%.`,
      metricLabel: "apr",
      metricValue: top.apr,
      action: "Send extra debt payments here first after minimums are covered.",
    });
  }
  if (input.investmentAllocation.concentrationWarnings.length > 0) {
    insights.push({
      kind: "investment_allocation",
      severity: "watch",
      title: "Investment allocation may be concentrated",
      detail: input.investmentAllocation.concentrationWarnings[0],
      action: "Review diversification before adding more to the same bucket.",
    });
  }
  insights.push({
    kind: "retirement_projection",
    severity: "info",
    title: "Retirement projection baseline saved",
    detail: `At the inferred contribution pace, 20-year projected investments are ${money(input.retirementProjection.projected20Year)}.`,
    metricLabel: "projected_20_year",
    metricValue: input.retirementProjection.projected20Year,
    action: "Add target retirement age and contribution limits to tighten this model.",
  });
  return insights;
}

function avgMonthlyIncome(incomeTxns: Txn[], today: string): number {
  const recent = sinceDays(incomeTxns, today, 120);
  if (recent.length === 0) return 0;
  const span = Math.max(30, daysBetween(recent[0].date, today));
  return roundMoney(recent.reduce((s, t) => s + Math.abs(t.amount), 0) / span * 30);
}

function selectPaycheckTransactions(incomeTxns: Txn[]): Txn[] {
  if (incomeTxns.length <= 2) return incomeTxns;
  const groups = new Map<string, Txn[]>();
  for (const txn of incomeTxns) {
    const key = normalizeIncomeSource(txn);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(txn);
  }

  let best: Txn[] = [];
  let bestScore = -Infinity;
  for (const txns of groups.values()) {
    if (txns.length < 2) continue;
    const sorted = [...txns].sort(byDateAsc);
    const amounts = sorted.map(t => Math.abs(t.amount));
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    if (avgAmount < 100) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = daysBetween(sorted[i - 1].date, sorted[i].date);
      if (gap >= 5 && gap <= 45) gaps.push(gap);
    }
    const cadence = normalizeCadence(median(gaps) || 30);
    const cadenceScore = gaps.filter(g => Math.abs(g - cadence) <= 3).length;
    const payrollHint = /payroll|paycheck|salary|direct dep|direct deposit|adp|gusto|paychex|workday/i.test(
      sorted.map(t => `${t.name} ${t.merchant_name || ""}`).join(" "),
    ) ? 2 : 1;
    const score = avgAmount * Math.max(1, sorted.length) * payrollHint + cadenceScore * 500;
    if (score > bestScore) {
      best = sorted;
      bestScore = score;
    }
  }

  if (best.length > 0) return best;
  const substantial = incomeTxns.filter(t => Math.abs(t.amount) >= 1000);
  return substantial.length >= 2 ? substantial : incomeTxns;
}

function normalizeIncomeSource(txn: Txn): string {
  const raw = (txn.merchant_name || txn.name || "income").toLowerCase();
  return raw
    .replace(/\b\d{2,}\b/g, "")
    .replace(/\b(payroll|direct|deposit|dep|ach|credit|ppd|id|trace)\b/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .slice(0, 48) || "income";
}

function avgMonthlyOutflow(txns: Txn[], today: string): number {
  const recent = sinceDays(txns, today, 120);
  if (recent.length === 0) return 0;
  const span = Math.max(30, daysBetween(recent[0].date, today));
  return roundMoney(recent.reduce((s, t) => s + Math.abs(t.amount), 0) / span * 30);
}

function estimateMonthlyInvestmentContribution(db: Database, monthlyIncome: number, monthlyOutflow: number): number {
  const rows = db.prepare(`
    SELECT amount, date, name, category
    FROM transactions
    WHERE amount > 0 AND date > date('now', '-120 days')
      AND (category IN ('TRANSFER_OUT', 'TRANSFER_IN') OR name LIKE '%401%' OR name LIKE '%ROTH%' OR name LIKE '%FIDELITY%' OR name LIKE '%VANGUARD%')
  `).all() as any[];
  const inferred = rows.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0) / 4;
  if (inferred > 0) return Math.min(inferred, monthlyIncome);
  return Math.max(0, (monthlyIncome - monthlyOutflow) * 0.25);
}

function isIncomeTxn(t: Txn): boolean {
  const text = `${t.name} ${t.merchant_name || ""} ${t.category || ""}`.toLowerCase();
  if (/dividend|interest paid|cash back|cashback|statement credit|payment thank|refund|tax ref|irs treas/.test(text)) {
    return false;
  }
  return t.amount < 0 && !INCOME_EXCLUDED_CATEGORIES.has(t.category || "");
}

function isSpendingTxn(t: Txn): boolean {
  return t.amount > 0 && !EXCLUDED_OUTFLOW_CATEGORIES.has(t.category || "");
}

function isEssentialTxn(t: Txn): boolean {
  const text = `${t.category || ""} ${t.subcategory || ""} ${t.name}`.toLowerCase();
  return /rent|mortgage|utility|utilities|loan|insurance|medical|health|grocery|supermarket|pharmacy|phone|internet|electric|gas/.test(text);
}

function frequencyDays(frequency: string): number {
  const f = String(frequency || "").toUpperCase();
  if (f.includes("WEEKLY")) return 7;
  if (f.includes("BIWEEKLY") || f.includes("FORTNIGHT")) return 14;
  if (f.includes("ANNUAL") || f.includes("YEAR")) return 365;
  if (f.includes("SEMI_MONTHLY")) return 15;
  return 30;
}

function repeatDates(anchor: string, everyDays: number, today: string, horizonDays: number): string[] {
  const dates: string[] = [];
  let date = anchor;
  while (date < today) date = addDays(date, everyDays);
  const end = addDays(today, horizonDays);
  while (date <= end) {
    dates.push(date);
    date = addDays(date, everyDays);
  }
  return dates;
}

function monthlyDates(dayOfMonth: number, today: string, horizonDays: number): string[] {
  const start = parseDate(today);
  const out: string[] = [];
  for (let offset = 0; offset <= 4; offset++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, Math.max(1, Math.min(28, dayOfMonth))));
    const iso = isoDate(d);
    if (iso >= today && daysBetween(today, iso) <= horizonDays) out.push(iso);
  }
  return out;
}

function sumDue(calendar: RecurringObligationCalendar, today: string, days: number): number {
  const end = addDays(today, days);
  return calendar.obligations
    .filter(o => o.date >= today && o.date <= end)
    .reduce((s, o) => s + o.amount, 0);
}

function inferApr(row: any, today: string): number {
  const promoEnabled = Number(row.enabled || 0) === 1;
  const promoEnd = row.promo_end_date ? String(row.promo_end_date) : null;
  if (promoEnabled && promoEnd) {
    const promoStart = row.promo_start_date ? String(row.promo_start_date) : "1900-01-01";
    if (today >= promoStart && today <= promoEnd) {
      return roundPct(Number.isFinite(Number(row.promo_apr)) ? Number(row.promo_apr) : 0);
    }
    if (Number.isFinite(Number(row.post_promo_apr)) && Number(row.post_promo_apr) > 0) {
      return roundPct(Number(row.post_promo_apr));
    }
  }
  if (row.interest_rate && Number(row.interest_rate) > 0) return roundPct(Number(row.interest_rate));
  if (row.type === "credit") return 22;
  if (row.subtype === "mortgage") return 6.5;
  if (row.subtype === "student") return 5.5;
  return 8.5;
}

function inferMinimum(row: any, balance: number): number {
  if (row.type === "credit") return Math.max(35, balance * 0.025);
  if (row.subtype === "mortgage") return balance * 0.006;
  return balance * 0.015;
}

function allocationLabel(type: string, text: string): string {
  const value = `${type} ${text}`.toLowerCase();
  if (/bond|fixed income|treasury/.test(value)) return "Bonds";
  if (/cash|money market/.test(value)) return "Cash";
  if (/crypto|bitcoin|ethereum/.test(value)) return "Crypto";
  if (/etf|mutual fund|equity|stock|common stock/.test(value)) return "Equities";
  return "Other";
}

function futureValue(principal: number, monthlyContribution: number, years: number, annualReturnPct: number): number {
  const r = annualReturnPct / 100 / 12;
  const n = years * 12;
  return principal * Math.pow(1 + r, n) + monthlyContribution * ((Math.pow(1 + r, n) - 1) / r);
}

function projectedCashByDate(points: BalancePoint[], date: string | null): number {
  if (!date) return points[13]?.cash ?? points[points.length - 1]?.cash ?? 0;
  const point = points.find(p => p.date >= date);
  return point?.cash ?? points[points.length - 1]?.cash ?? 0;
}

function cashAtDay(points: BalancePoint[], day: number): number {
  return roundMoney(points[Math.min(points.length - 1, Math.max(0, day - 1))]?.cash ?? 0);
}

function pressureFromCash(cash: number, pressureBase: number): "low" | "medium" | "high" {
  if (cash < 0 || cash < pressureBase * 0.25) return "high";
  if (cash < pressureBase * 0.75) return "medium";
  return "low";
}

function normalizeCadence(days: number): number {
  if (days <= 9) return 7;
  if (days <= 18) return 14;
  if (days <= 24) return 15;
  return 30;
}

function sinceDays(txns: Txn[], today: string, days: number): Txn[] {
  const cutoff = addDays(today, -days);
  return txns.filter(t => t.date >= cutoff && t.date <= today);
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function addDaysUntilFuture(anchor: string, cadenceDays: number, today: string): string {
  let date = addDays(anchor, cadenceDays);
  while (date <= today) date = addDays(date, cadenceDays);
  return date;
}

function nextMonthlyAnchor(today: string, monthsAhead: number): string {
  const date = parseDate(today);
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsAhead, date.getUTCDate())));
}

function byDateAsc(a: Txn, b: Txn): number {
  return a.date.localeCompare(b.date);
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / DAY_MS);
}

function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sumRows(row: any): number {
  return roundMoney(Number(row?.total || 0));
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 10) / 10;
}

function money(value: number): string {
  return `$${roundMoney(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
