import { describe, expect, it } from "vitest";
import { compareDebtPayoffStrategies } from "./debt-strategies.js";

describe("debt strategy comparison", () => {
  it("shows avalanche usually beats snowball on total interest", () => {
    const result = compareDebtPayoffStrategies({
      debts: [
        { id: "card-a", name: "Card A", balance: 8000, aprPct: 29.99, minPayment: 160 },
        { id: "card-b", name: "Card B", balance: 3000, aprPct: 12.99, minPayment: 75 },
      ],
      extraMonthly: 250,
    });

    const avalanche = result.strategies.find(s => s.strategy === "avalanche")!;
    const snowball = result.strategies.find(s => s.strategy === "snowball")!;

    expect(avalanche.monthsToDebtFree).not.toBeNull();
    expect(snowball.monthsToDebtFree).not.toBeNull();
    expect(avalanche.totalInterestPaid).toBeLessThanOrEqual(snowball.totalInterestPaid);
  });

  it("supports custom order by debt id", () => {
    const result = compareDebtPayoffStrategies({
      debts: [
        { id: "x", name: "Card X", balance: 4000, aprPct: 22, minPayment: 100 },
        { id: "y", name: "Card Y", balance: 2000, aprPct: 10, minPayment: 60 },
      ],
      extraMonthly: 200,
      customOrder: ["y", "x"],
    });

    const custom = result.strategies.find(s => s.strategy === "custom")!;
    expect(custom.payoffOrder[0]).toBe("Card Y");
  });

  it("can include a minimum-only baseline", () => {
    const result = compareDebtPayoffStrategies({
      debts: [
        { id: "m1", name: "Card M1", balance: 5000, aprPct: 25, minPayment: 120 },
        { id: "m2", name: "Card M2", balance: 2200, aprPct: 9, minPayment: 55 },
      ],
      extraMonthly: 150,
      includeMinimum: true,
    });

    const baseline = result.strategies.find(s => s.strategy === "minimum")!;
    const avalanche = result.strategies.find(s => s.strategy === "avalanche")!;
    expect(baseline.totalInterestPaid).toBeGreaterThan(avalanche.totalInterestPaid);
  });
});
