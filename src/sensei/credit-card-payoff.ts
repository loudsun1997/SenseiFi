export type CreditCardPayoffInput = {
  balance: number;
  apr: number; // 0.2499 for 24.99%
  monthlyPayment?: number;
  targetMonths?: number;
  minimumPaymentPercent?: number;
  minimumPaymentFloor?: number;
  newMonthlyCharges?: number;
  fees?: {
    monthlyFee?: number;
    oneTimeFee?: number;
  };
  promotionalApr?: number; // decimal form, e.g. 0 for 0%
  promotionalMonths?: number;
  maxMonths?: number;
};

export type CreditCardPayoffMonth = {
  month: number;
  startingBalance: number;
  interestCharged: number;
  payment: number;
  principalPaid: number;
  endingBalance: number;
};

export type CreditCardPayoffResult = {
  monthsToPayoff: number | null;
  totalInterestPaid: number;
  totalPaid: number;
  finalPayment: number;
  requiredMonthlyPayment: number | null;
  schedule: CreditCardPayoffMonth[];
  warnings: string[];
};

interface NormalizedInput {
  balance: number;
  apr: number;
  monthlyPayment: number | null;
  targetMonths: number | null;
  minimumPaymentPercent: number;
  minimumPaymentFloor: number;
  newMonthlyCharges: number;
  monthlyFee: number;
  oneTimeFee: number;
  promotionalApr: number | null;
  promotionalMonths: number;
  maxMonths: number;
}

interface SimulationResult {
  monthsToPayoff: number | null;
  totalInterestPaid: number;
  totalPaid: number;
  finalPayment: number;
  schedule: CreditCardPayoffMonth[];
  warnings: string[];
}

export function calculateCreditCardPayoff(raw: CreditCardPayoffInput): CreditCardPayoffResult {
  const input = normalizeInput(raw);
  const warnings: string[] = [];

  if (input.monthlyPayment == null && input.targetMonths == null) {
    warnings.push("No monthly payment was provided; using issuer-style minimum payment rules.");
  }

  let requiredMonthlyPayment: number | null = null;
  let effectiveMonthlyPayment = input.monthlyPayment;
  if (effectiveMonthlyPayment == null && input.targetMonths != null) {
    requiredMonthlyPayment = findRequiredMonthlyPayment(input, input.targetMonths);
    effectiveMonthlyPayment = requiredMonthlyPayment;
    if (requiredMonthlyPayment == null) {
      warnings.push(`Could not find a monthly payment that pays off the balance in ${input.targetMonths} months.`);
    }
  }

  const simulation = runSimulation(input, effectiveMonthlyPayment);
  if (simulation.monthsToPayoff == null) {
    warnings.push(`Balance was not fully paid within ${input.maxMonths} months.`);
  }
  if (input.newMonthlyCharges > 0) {
    warnings.push("New monthly charges are enabled; this can significantly delay payoff.");
  }
  if (input.promotionalApr != null && input.promotionalMonths > 0) {
    warnings.push(`Promotional APR is applied for ${input.promotionalMonths} months, then standard APR resumes.`);
  }

  return {
    monthsToPayoff: simulation.monthsToPayoff,
    totalInterestPaid: simulation.totalInterestPaid,
    totalPaid: simulation.totalPaid,
    finalPayment: simulation.finalPayment,
    requiredMonthlyPayment,
    schedule: simulation.schedule,
    warnings: [...warnings, ...simulation.warnings],
  };
}

function runSimulation(input: NormalizedInput, fixedMonthlyPayment: number | null): SimulationResult {
  let balance = input.balance;
  let totalInterestPaid = 0;
  let totalPaid = 0;
  let finalPayment = 0;
  const schedule: CreditCardPayoffMonth[] = [];
  const warnings: string[] = [];

  for (let month = 1; month <= input.maxMonths; month++) {
    if (balance <= 0.005) {
      return {
        monthsToPayoff: month - 1,
        totalInterestPaid: roundMoney(totalInterestPaid),
        totalPaid: roundMoney(totalPaid),
        finalPayment: roundMoney(finalPayment),
        schedule,
        warnings,
      };
    }

    const startingBalance = balance;
    const oneTimeFee = month === 1 ? input.oneTimeFee : 0;
    const principalBeforeInterest = startingBalance + input.newMonthlyCharges + input.monthlyFee + oneTimeFee;
    const monthlyRate = getMonthlyRate(input, month);
    const interestCharged = principalBeforeInterest * monthlyRate;
    const statementBalance = principalBeforeInterest + interestCharged;
    const minimumDue = computeMinimumDue(
      statementBalance,
      principalBeforeInterest,
      interestCharged,
      input.minimumPaymentPercent,
      input.minimumPaymentFloor,
    );

    let payment = fixedMonthlyPayment == null ? minimumDue : Math.max(fixedMonthlyPayment, minimumDue);
    payment = Math.min(payment, statementBalance);

    if (fixedMonthlyPayment != null && fixedMonthlyPayment + 0.01 < minimumDue && month === 1) {
      warnings.push(`Provided payment ${roundMoney(fixedMonthlyPayment)} is below estimated minimum due ${roundMoney(minimumDue)}; minimum due was used instead.`);
    }

    const principalPaid = payment - interestCharged;
    const endingBalance = Math.max(0, statementBalance - payment);
    balance = endingBalance;
    totalInterestPaid += interestCharged;
    totalPaid += payment;
    finalPayment = payment;

    schedule.push({
      month,
      startingBalance: roundMoney(startingBalance),
      interestCharged: roundMoney(interestCharged),
      payment: roundMoney(payment),
      principalPaid: roundMoney(principalPaid),
      endingBalance: roundMoney(endingBalance),
    });
  }

  return {
    monthsToPayoff: null,
    totalInterestPaid: roundMoney(totalInterestPaid),
    totalPaid: roundMoney(totalPaid),
    finalPayment: roundMoney(finalPayment),
    schedule,
    warnings,
  };
}

function findRequiredMonthlyPayment(input: NormalizedInput, targetMonths: number): number | null {
  const initialMonthlyRate = getMonthlyRate(input, 1);
  const minLowerBound = Math.max(
    computeMinimumDue(
      input.balance * (1 + initialMonthlyRate),
      input.balance,
      input.balance * initialMonthlyRate,
      input.minimumPaymentPercent,
      input.minimumPaymentFloor,
    ),
    input.balance / Math.max(1, targetMonths),
  );

  let low = Math.max(0, minLowerBound);
  let high = Math.max(low + 1, input.balance * 2);

  while (high < input.balance * 5) {
    const attempt = runSimulation(input, high);
    if (attempt.monthsToPayoff != null && attempt.monthsToPayoff <= targetMonths) break;
    high *= 1.5;
  }

  const highAttempt = runSimulation(input, high);
  if (highAttempt.monthsToPayoff == null || highAttempt.monthsToPayoff > targetMonths) return null;

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const attempt = runSimulation(input, mid);
    if (attempt.monthsToPayoff != null && attempt.monthsToPayoff <= targetMonths) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return roundMoney(high);
}

function normalizeInput(raw: CreditCardPayoffInput): NormalizedInput {
  const balance = Number(raw.balance);
  const apr = Number(raw.apr);
  if (!Number.isFinite(balance) || balance < 0) {
    throw new Error("balance must be a non-negative number.");
  }
  if (!Number.isFinite(apr) || apr < 0) {
    throw new Error("apr must be a non-negative decimal like 0.2499 for 24.99%.");
  }

  const monthlyPayment = raw.monthlyPayment == null ? null : Number(raw.monthlyPayment);
  if (monthlyPayment != null && (!Number.isFinite(monthlyPayment) || monthlyPayment <= 0)) {
    throw new Error("monthlyPayment must be a positive number when provided.");
  }

  const targetMonths = raw.targetMonths == null ? null : Math.round(Number(raw.targetMonths));
  if (targetMonths != null && (!Number.isFinite(targetMonths) || targetMonths <= 0)) {
    throw new Error("targetMonths must be a positive integer when provided.");
  }

  const minimumPaymentPercent = clamp(Number(raw.minimumPaymentPercent ?? 0.01), 0.0025, 0.1);
  const minimumPaymentFloor = Math.max(15, Number(raw.minimumPaymentFloor ?? 25));
  const newMonthlyCharges = Math.max(0, Number(raw.newMonthlyCharges ?? 0));
  const monthlyFee = Math.max(0, Number(raw.fees?.monthlyFee ?? 0));
  const oneTimeFee = Math.max(0, Number(raw.fees?.oneTimeFee ?? 0));
  const promotionalApr = raw.promotionalApr == null ? null : Number(raw.promotionalApr);
  const promotionalMonths = Math.max(0, Math.round(Number(raw.promotionalMonths ?? 0)));
  const maxMonths = Math.max(12, Math.round(Number(raw.maxMonths ?? 600)));

  if (promotionalApr != null && (!Number.isFinite(promotionalApr) || promotionalApr < 0)) {
    throw new Error("promotionalApr must be a non-negative decimal when provided.");
  }

  return {
    balance,
    apr,
    monthlyPayment,
    targetMonths,
    minimumPaymentPercent,
    minimumPaymentFloor,
    newMonthlyCharges,
    monthlyFee,
    oneTimeFee,
    promotionalApr,
    promotionalMonths,
    maxMonths,
  };
}

function computeMinimumDue(
  statementBalance: number,
  principalBeforeInterest: number,
  interestCharged: number,
  minimumPaymentPercent: number,
  minimumPaymentFloor: number,
): number {
  const percentOnly = principalBeforeInterest * minimumPaymentPercent;
  const interestPlusPercent = interestCharged + percentOnly;
  const estimatedMinimum = Math.max(minimumPaymentFloor, percentOnly, interestPlusPercent);
  return Math.min(statementBalance, estimatedMinimum);
}

function getMonthlyRate(input: NormalizedInput, month: number): number {
  if (input.promotionalApr != null && month <= input.promotionalMonths) {
    return input.promotionalApr / 12;
  }
  return input.apr / 12;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
