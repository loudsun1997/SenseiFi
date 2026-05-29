import { describe, expect, it } from "vitest";
import { calculateCreditCardPayoff } from "./credit-card-payoff.js";

describe("credit-card payoff", () => {
  it("simulates payoff with a fixed monthly payment", () => {
    const result = calculateCreditCardPayoff({
      balance: 7000,
      apr: 0.21,
      monthlyPayment: 200,
      minimumPaymentPercent: 0.01,
      minimumPaymentFloor: 25,
    });

    expect(result.monthsToPayoff).not.toBeNull();
    expect(result.monthsToPayoff!).toBeGreaterThan(30);
    expect(result.monthsToPayoff!).toBeLessThan(70);
    expect(result.totalInterestPaid).toBeGreaterThan(0);
    expect(result.totalPaid).toBeGreaterThan(7000);
    expect(result.schedule.length).toBe(result.monthsToPayoff);
  });

  it("calculates required payment for a target payoff date", () => {
    const result = calculateCreditCardPayoff({
      balance: 7000,
      apr: 0.21,
      targetMonths: 24,
      minimumPaymentPercent: 0.01,
      minimumPaymentFloor: 25,
    });

    expect(result.requiredMonthlyPayment).not.toBeNull();
    expect(result.requiredMonthlyPayment!).toBeGreaterThan(300);
    expect(result.monthsToPayoff).toBeLessThanOrEqual(24);
  });

  it("supports promotional APR windows", () => {
    const withPromo = calculateCreditCardPayoff({
      balance: 7000,
      apr: 0.21,
      monthlyPayment: 250,
      promotionalApr: 0,
      promotionalMonths: 12,
    });
    const withoutPromo = calculateCreditCardPayoff({
      balance: 7000,
      apr: 0.21,
      monthlyPayment: 250,
    });

    expect(withPromo.totalInterestPaid).toBeLessThan(withoutPromo.totalInterestPaid);
    expect(withPromo.monthsToPayoff).toBeLessThanOrEqual(withoutPromo.monthsToPayoff!);
  });

  it("flags when revolving behavior prevents payoff", () => {
    const result = calculateCreditCardPayoff({
      balance: 5000,
      apr: 0.29,
      monthlyPayment: 120,
      newMonthlyCharges: 180,
      maxMonths: 120,
    });

    expect(result.monthsToPayoff).toBeNull();
    expect(result.warnings.join(" ")).toContain("not fully paid");
  });
});
