import type Database from "libsql";
import type { ToolDefinition } from "./provider.js";
import {
  getNetWorth, getAccountBalances, getTransactionsFiltered,
  getRecentSpending, getBudgetStatuses, getGoals,
  getIncome, searchTransactions, getCashFlow, forecastBalance,
  getPortfolio, getInvestmentPerformance, getDebts,
  compareSpending, getNetWorthTrend,
  formatMoney, categoryLabel,
} from "../queries/index.js";
import { getLatestScore, getMonthlySavings } from "../scoring/index.js";
import { generateAlerts } from "../alerts/index.js";
import { saveMemory, getMemories } from "./memory.js";
import { readContext, writeContext, replaceContextSection } from "./context.js";
import { createBnplPlan, getBnplLedger, getBnplPressure } from "../sensei/bnpl.js";
import { calculateCreditCardPayoff } from "../sensei/credit-card-payoff.js";
import { compareDebtPayoffStrategies } from "../sensei/debt-strategies.js";
import { evaluatePurchase, recordPurchaseDecision, savePurchaseConsultation } from "../sensei/purchase-consultant.js";
import { getFrictionCommitments, resolveFrictionCommitment } from "../sensei/strategic-friction.js";
import { getAssetVpu, getRecentAssetVpu, logAssetUsage } from "../sensei/vpu.js";

export const toolDefinitions: ToolDefinition[] = [
  // --- Existing tools ---
  {
    name: "get_net_worth",
    description: "Get current net worth with breakdown of assets, liabilities, investments, cash, and home equity",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_accounts",
    description: "List all linked bank accounts with current balances",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_transactions",
    description: "Search transactions with optional filters. Returns matching transactions.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 30 days ago." },
        end_date: { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
        category: { type: "string", description: "Filter by category (e.g. FOOD_AND_DRINK, GENERAL_MERCHANDISE)" },
        merchant: { type: "string", description: "Filter by merchant name (partial match)" },
        min_amount: { type: "number", description: "Minimum transaction amount" },
        max_amount: { type: "number", description: "Maximum transaction amount" },
        limit: { type: "number", description: "Max results to return (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "get_spending_summary",
    description: "Get spending breakdown by category for a time period",
    input_schema: {
      type: "object" as const,
      properties: {
        period: { type: "string", description: "Period: this_month, last_month, last_30, last_90, or YYYY-MM-DD:YYYY-MM-DD", default: "this_month" },
      },
      required: [],
    },
  },
  {
    name: "get_budgets",
    description: "Get all budget categories with current month spending vs limits",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "set_budget",
    description: "Create or update a monthly budget for a spending category",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Plaid category (e.g. FOOD_AND_DRINK, GENERAL_MERCHANDISE, ENTERTAINMENT)" },
        monthly_limit: { type: "number", description: "Monthly budget limit in dollars" },
      },
      required: ["category", "monthly_limit"],
    },
  },
  {
    name: "get_goals",
    description: "Get financial goals with progress tracking",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "set_goal",
    description: "Create or update a financial goal",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Goal name" },
        target_amount: { type: "number", description: "Target amount in dollars" },
        current_amount: { type: "number", description: "Current amount saved (optional)" },
        target_date: { type: "string", description: "Target date (YYYY-MM-DD, optional)" },
      },
      required: ["name", "target_amount"],
    },
  },
  {
    name: "get_score",
    description: "Get the latest daily financial behavior score (0-100) and streaks",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_recurring",
    description: "List detected recurring transactions and bills",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_alerts",
    description: "Get current financial alerts (large transactions, low balances, budget overruns)",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "save_memory",
    description: "Save an important fact or preference to long-term memory. Use this when the user shares something worth remembering across conversations.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The fact or preference to remember" },
        category: { type: "string", description: "Category: general, preference, goal, life_event", default: "general" },
      },
      required: ["content"],
    },
  },
  {
    name: "get_memories",
    description: "Retrieve all saved long-term memories",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },

  // --- New: Income & Search ---
  {
    name: "get_income",
    description: "Get income sources and amounts for a time period",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to start of current month." },
        end_date: { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
      },
      required: [],
    },
  },
  {
    name: "search_transactions",
    description: "Full-text search transactions by name, merchant, or category. Use this when the user asks to find specific transactions.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (matches name, merchant, or category)" },
        limit: { type: "number", description: "Max results (default 30)" },
      },
      required: ["query"],
    },
  },
  {
    name: "categorize_transaction",
    description: "Re-categorize a specific transaction",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "The transaction ID to recategorize" },
        category: { type: "string", description: "New category (e.g. FOOD_AND_DRINK, GENERAL_MERCHANDISE)" },
        subcategory: { type: "string", description: "New subcategory (optional)" },
      },
      required: ["transaction_id", "category"],
    },
  },

  // --- New: Analysis ---
  {
    name: "cash_flow",
    description: "Analyze income vs expenses with savings rate and monthly breakdown",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD). Defaults to 3 months ago." },
        end_date: { type: "string", description: "End date (YYYY-MM-DD). Defaults to today." },
      },
      required: [],
    },
  },
  {
    name: "forecast_balance",
    description: "Project account balance N months forward based on recent cash flow patterns",
    input_schema: {
      type: "object" as const,
      properties: {
        account_id: { type: "string", description: "Specific account ID (optional, defaults to all depository)" },
        months: { type: "number", description: "Number of months to forecast (default 6)" },
      },
      required: [],
    },
  },
  {
    name: "compare_spending",
    description: "Side-by-side spending comparison of two time periods, broken down by category",
    input_schema: {
      type: "object" as const,
      properties: {
        period1_start: { type: "string", description: "Period 1 start date (YYYY-MM-DD)" },
        period1_end: { type: "string", description: "Period 1 end date (YYYY-MM-DD)" },
        period2_start: { type: "string", description: "Period 2 start date (YYYY-MM-DD)" },
        period2_end: { type: "string", description: "Period 2 end date (YYYY-MM-DD)" },
      },
      required: ["period1_start", "period1_end", "period2_start", "period2_end"],
    },
  },
  {
    name: "get_net_worth_trend",
    description: "Get net worth history over time to see the trend",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Number of data points (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "get_monthly_savings",
    description: "Compare this month's spending pace to the baseline month to see how much you're saving",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },

  // --- New: Investments ---
  {
    name: "get_portfolio",
    description: "Get investment holdings grouped by account with values, cost basis, and gain/loss",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "investment_performance",
    description: "Get investment returns vs cost basis for each holding",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },

  // --- New: Debts ---
  {
    name: "get_debts",
    description: "List all debts with balances, interest rates, and minimum payments",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "calculate_debt_payoff",
    description: "Simulate portfolio debt payoff with minimum, avalanche, or snowball strategy and optional extra payment",
    input_schema: {
      type: "object" as const,
      properties: {
        strategy: { type: "string", description: "Payoff strategy: minimum, avalanche (highest rate first), or snowball (lowest balance first)", default: "avalanche" },
        extra_monthly: { type: "number", description: "Extra monthly payment beyond minimums (default 0)" },
      },
      required: [],
    },
  },
  {
    name: "compare_debt_payoff_strategies",
    description: "Compare avalanche, snowball, and optional custom debt payoff order using a month-by-month portfolio simulation.",
    input_schema: {
      type: "object" as const,
      properties: {
        extra_monthly: { type: "number", description: "Extra monthly payment on top of all minimums." },
        include_minimum: { type: "boolean", description: "Include a minimum-payment-only baseline." },
        custom_order: {
          type: "array",
          items: { type: "string" },
          description: "Custom debt priority list by debt name or id as shown in get_debts.",
        },
      },
      required: [],
    },
  },
  {
    name: "calculate_credit_card_payoff",
    description: "Simulate month-by-month credit-card payoff with issuer-style minimum payment rules, optional promo APR, and target payoff date support.",
    input_schema: {
      type: "object" as const,
      properties: {
        balance: { type: "number", description: "Current balance" },
        apr: { type: "number", description: "APR as decimal, e.g. 0.2499 for 24.99%" },
        monthly_payment: { type: "number", description: "Fixed monthly payment amount. If omitted, minimum payment logic is used." },
        target_months: { type: "number", description: "Desired payoff timeline in months. Calculates required monthly payment when monthly_payment is omitted." },
        minimum_payment_percent: { type: "number", description: "Minimum payment percent of principal (default 0.01)." },
        minimum_payment_floor: { type: "number", description: "Minimum payment floor amount (default 25)." },
        new_monthly_charges: { type: "number", description: "Expected new charges per month (default 0)." },
        promotional_apr: { type: "number", description: "Promo APR as decimal during promotional months, e.g. 0 for 0%." },
        promotional_months: { type: "number", description: "How many months the promotional APR applies." },
        max_months: { type: "number", description: "Max simulation horizon in months (default 600)." },
        fees: {
          type: "object",
          properties: {
            monthly_fee: { type: "number", description: "Monthly maintenance fee amount." },
            one_time_fee: { type: "number", description: "One-time fee charged in month 1, e.g. transfer fee." },
          },
          required: [],
        },
      },
      required: ["balance", "apr"],
    },
  },
  {
    name: "get_bnpl_pressure",
    description: "Get BNPL cash pressure from tracked installment plans, including 30/60/90 day drag, monthly obligation load, upcoming installments, and payment collisions.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of days ahead to inspect (default 90)" },
      },
      required: [],
    },
  },
  {
    name: "get_bnpl_ledger",
    description: "Get the chronological BNPL installment ledger for tracked active plans.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of days ahead to inspect (default 90)" },
      },
      required: [],
    },
  },
  {
    name: "add_bnpl_plan",
    description: "Add a BNPL installment plan to the pressure ledger when the user provides plan details.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_name: { type: "string", description: "Item or purchase name" },
        total_amount: { type: "number", description: "Total purchase amount" },
        installment_count: { type: "number", description: "Number of remaining installments" },
        next_payment_date: { type: "string", description: "Next payment date (YYYY-MM-DD)" },
        provider: { type: "string", description: "BNPL provider, e.g. Affirm, Klarna, Afterpay" },
        merchant: { type: "string", description: "Merchant name" },
        remaining_amount: { type: "number", description: "Remaining amount if different from total amount" },
        installment_amount: { type: "number", description: "Installment amount if fixed" },
        frequency_days: { type: "number", description: "Days between installments (default 14)" },
        note: { type: "string", description: "Optional note" },
      },
      required: ["item_name", "total_amount", "installment_count", "next_payment_date"],
    },
  },
  {
    name: "evaluate_purchase",
    description: "Run the Sensei-Fi purchase consultant. Use this whenever the user asks whether they should buy something, whether a purchase is worth it, or wants a buy/wait/rent/skip recommendation.",
    input_schema: {
      type: "object" as const,
      properties: {
        item_name: { type: "string", description: "Item or purchase name" },
        price: { type: "number", description: "Purchase price" },
        category: { type: "string", description: "Purchase category, e.g. cycling, software, tool, electronics" },
        merchant: { type: "string", description: "Merchant name" },
        payment_mode: { type: "string", description: "cash or bnpl", default: "cash" },
        urgency: { type: "string", description: "low, normal, or high", default: "normal" },
        expected_uses_per_month: { type: "number", description: "Expected uses per month" },
        expected_months: { type: "number", description: "Expected months of use" },
        rent_cost: { type: "number", description: "Rental/borrow/test cost for comparison" },
        installment_count: { type: "number", description: "BNPL installment count if evaluating BNPL" },
        installment_amount: { type: "number", description: "BNPL installment amount if fixed" },
        down_payment: { type: "number", description: "BNPL down payment" },
        installment_every_days: { type: "number", description: "Days between BNPL installments" },
        save: { type: "boolean", description: "Whether to save the consultation, default true" },
      },
      required: ["item_name", "price"],
    },
  },
  {
    name: "record_purchase_decision",
    description: "Record the user's final decision after a saved purchase consultation.",
    input_schema: {
      type: "object" as const,
      properties: {
        consultation_id: { type: "number", description: "Saved purchase consultation ID" },
        decision: { type: "string", description: "buy, wait, rent, skip, or custom decision" },
        note: { type: "string", description: "Optional note" },
      },
      required: ["consultation_id", "decision"],
    },
  },
  {
    name: "log_asset_usage",
    description: "Log real-world usage for an owned asset so Sensei-Fi can calculate value-per-use, such as cost-per-mile, cost-per-project, cost-per-hour, or cost-per-use.",
    input_schema: {
      type: "object" as const,
      properties: {
        asset_name: { type: "string", description: "Asset name" },
        category: { type: "string", description: "Asset category, e.g. cycling, tool, software" },
        purchase_price: { type: "number", description: "Purchase price/cost basis if known" },
        usage_metric: { type: "string", description: "Usage metric, e.g. mile, project, hour, use" },
        quantity: { type: "number", description: "Usage quantity" },
        used_at: { type: "string", description: "Usage date (YYYY-MM-DD)" },
        note: { type: "string", description: "Optional note" },
      },
      required: ["asset_name"],
    },
  },
  {
    name: "get_asset_vpu",
    description: "Get value-per-use for one asset or recent assets.",
    input_schema: {
      type: "object" as const,
      properties: {
        asset_name: { type: "string", description: "Asset name. If omitted, returns recent assets." },
        limit: { type: "number", description: "Number of recent assets when asset_name is omitted" },
      },
      required: [],
    },
  },
  {
    name: "get_strategic_friction",
    description: "Get active strategic friction commitments such as 48-hour cooldowns, rent-first checks, usage audits, and BNPL cash-price checks.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "active, resolved, expired, dismissed, or all", default: "active" },
        due_within_days: { type: "number", description: "Only return commitments due within N days" },
      },
      required: [],
    },
  },
  {
    name: "resolve_strategic_friction",
    description: "Resolve a strategic friction commitment after the user reports what happened.",
    input_schema: {
      type: "object" as const,
      properties: {
        commitment_id: { type: "number", description: "Strategic friction commitment ID" },
        resolution: { type: "string", description: "What happened" },
        status: { type: "string", description: "resolved, expired, or dismissed", default: "resolved" },
      },
      required: ["commitment_id", "resolution"],
    },
  },

  // --- New: Context ---
  {
    name: "update_context",
    description: "Update the persistent financial context file. Use when circumstances change: new decisions, completed goals, changed balances, updated strategy, or important life events. Use 'section' param to replace a specific section cleanly.",
    input_schema: {
      type: "object" as const,
      properties: {
        updates: { type: "string", description: "Description of what changed and the new information to incorporate (used when no section specified)" },
        section: { type: "string", description: "Section heading to replace (e.g. 'Family', 'Income', 'Goals', 'Strategy'). Replaces everything under that ## heading." },
        content: { type: "string", description: "New content for the section (used with section param)" },
      },
      required: [],
    },
  },

  // --- New: Data modification ---
  {
    name: "delete_budget",
    description: "Remove a budget category",
    input_schema: {
      type: "object" as const,
      properties: {
        category: { type: "string", description: "Budget category to delete" },
      },
      required: ["category"],
    },
  },
  {
    name: "delete_goal",
    description: "Remove a financial goal",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Goal name to delete" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_goal_progress",
    description: "Update the current amount on a financial goal",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Goal name" },
        current_amount: { type: "number", description: "New current amount" },
      },
      required: ["name", "current_amount"],
    },
  },
  {
    name: "label_transaction",
    description: "Add a note or label to a transaction for personal tracking",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "Transaction ID" },
        label: { type: "string", description: "Label text (optional)" },
        note: { type: "string", description: "Note text (optional)" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "add_recat_rule",
    description: "Create an auto-recategorization rule for future syncs. Transactions matching the pattern will be automatically recategorized.",
    input_schema: {
      type: "object" as const,
      properties: {
        match_field: { type: "string", description: "Field to match: name, merchant_name" },
        match_pattern: { type: "string", description: "Pattern to match (case-insensitive substring)" },
        target_category: { type: "string", description: "Category to assign" },
        target_subcategory: { type: "string", description: "Subcategory (optional)" },
        label: { type: "string", description: "Label to apply (optional)" },
      },
      required: ["match_field", "match_pattern", "target_category"],
    },
  },
];

export async function executeTool(db: Database.Database, toolName: string, toolInput: any): Promise<string> {
  switch (toolName) {
    case "get_net_worth": {
      const nw = getNetWorth(db);
      const change = nw.prev_net_worth !== null ? nw.net_worth - nw.prev_net_worth : null;
      let result = `Net worth: ${formatMoney(nw.net_worth)}`;
      if (change !== null) result += ` (${change >= 0 ? "+" : ""}${formatMoney(change)} from yesterday)`;
      result += `\nAssets: ${formatMoney(nw.assets)} | Liabilities: ${formatMoney(nw.liabilities)}`;
      result += `\nHome equity: ${formatMoney(nw.home_equity)} | Investments: ${formatMoney(nw.investments)} | Cash: ${formatMoney(nw.cash)}`;
      if (nw.credit_debt > 0) result += `\nCredit card debt: ${formatMoney(nw.credit_debt)}`;
      if (nw.mortgage > 0) result += `\nMortgage: ${formatMoney(nw.mortgage)}`;
      return result;
    }

    case "get_accounts": {
      const accounts = getAccountBalances(db);
      if (accounts.length === 0) return "No accounts linked yet.";
      return accounts.map(a => `${a.name} (${a.type}): ${["credit", "loan"].includes(a.type) ? "-" : ""}${formatMoney(a.balance)}`).join("\n");
    }

    case "get_transactions": {
      const txns = getTransactionsFiltered(db, {
        startDate: toolInput.start_date,
        endDate: toolInput.end_date,
        category: toolInput.category,
        merchant: toolInput.merchant,
        minAmount: toolInput.min_amount,
        maxAmount: toolInput.max_amount,
        limit: toolInput.limit,
      });
      if (txns.length === 0) return "No transactions found matching those filters.";
      return txns.map(t => `${t.date} | ${t.name} | ${formatMoney(t.amount)} | ${categoryLabel(t.category)}`).join("\n");
    }

    case "get_spending_summary": {
      const period = toolInput.period || "this_month";
      const { resolvePeriod } = await import("../db/helpers.js");
      const { start, end } = resolvePeriod(period);
      const rows = db.prepare(
        `SELECT category, SUM(amount) as total, COUNT(*) as count FROM transactions
         WHERE amount > 0 AND date BETWEEN ? AND ? AND pending = 0
         AND category NOT IN ('TRANSFER_OUT', 'TRANSFER_IN', 'LOAN_PAYMENTS')
         GROUP BY category ORDER BY total DESC`
      ).all(start, end) as { category: string; total: number; count: number }[];
      if (rows.length === 0) return "No spending found for that period.";
      const grandTotal = rows.reduce((s, r) => s + r.total, 0);
      let result = `Spending ${start} to ${end}: ${formatMoney(grandTotal)} total\n\n`;
      result += rows.map(r => `${categoryLabel(r.category)}: ${formatMoney(r.total)} (${r.count} transactions)`).join("\n");
      return result;
    }

    case "get_budgets": {
      const budgets = getBudgetStatuses(db);
      if (budgets.length === 0) return "No budgets set up yet. Use set_budget to create one.";
      const now = new Date();
      const monthPct = Math.round((now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100);
      let result = `Budget status (${monthPct}% through the month):\n\n`;
      result += budgets.map(b => {
        const status = b.over_budget ? "OVER" : `${b.pct_used}%`;
        return `${b.over_budget ? "!" : "•"} ${categoryLabel(b.category)}: ${formatMoney(b.spent)} / ${formatMoney(b.budget)} (${status})${b.over_budget ? ` — ${formatMoney(Math.abs(b.remaining))} over` : ""}`;
      }).join("\n");
      return result;
    }

    case "set_budget": {
      db.prepare(
        `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?)
         ON CONFLICT(category, period) DO UPDATE SET monthly_limit = excluded.monthly_limit`
      ).run(toolInput.category, toolInput.monthly_limit);
      return `Budget set: ${categoryLabel(toolInput.category)} at ${formatMoney(toolInput.monthly_limit)}/month`;
    }

    case "get_goals": {
      const goals = getGoals(db);
      if (goals.length === 0) return "No goals set up yet. Use set_goal to create one.";
      return goals.map(g => {
        let line = `${g.name}: ${formatMoney(g.current)} / ${formatMoney(g.target)} (${g.progress_pct}%)`;
        if (g.target_date) line += ` — target: ${g.target_date}`;
        if (g.monthly_needed > 0) line += ` — need ${formatMoney(g.monthly_needed)}/mo`;
        return line;
      }).join("\n");
    }

    case "set_goal": {
      const existing = db.prepare(`SELECT id FROM goals WHERE name = ?`).get(toolInput.name) as any;
      if (existing) {
        const updates: string[] = [];
        const params: any[] = [];
        if (toolInput.target_amount !== undefined) { updates.push("target_amount = ?"); params.push(toolInput.target_amount); }
        if (toolInput.current_amount !== undefined) { updates.push("current_amount = ?"); params.push(toolInput.current_amount); }
        if (toolInput.target_date !== undefined) { updates.push("target_date = ?"); params.push(toolInput.target_date); }
        if (updates.length === 0) return `Goal "${toolInput.name}" exists but no changes provided.`;
        params.push(existing.id);
        db.prepare(`UPDATE goals SET ${updates.join(", ")} WHERE id = ?`).run(...params);
        return `Goal "${toolInput.name}" updated.`;
      } else {
        db.prepare(
          `INSERT INTO goals (name, target_amount, current_amount, target_date) VALUES (?, ?, ?, ?)`
        ).run(toolInput.name, toolInput.target_amount, toolInput.current_amount || 0, toolInput.target_date || null);
        return `Goal "${toolInput.name}" created: target ${formatMoney(toolInput.target_amount)}`;
      }
    }

    case "get_score": {
      const score = getLatestScore(db);
      if (!score) return "No daily scores calculated yet. Scores are calculated during the daily sync.";
      let result = `Daily score: ${score.score}/100 (${score.date})`;
      result += `\nStreaks: ${score.no_restaurant_streak}d no restaurants | ${score.no_shopping_streak}d no shopping | ${score.on_pace_streak}d on pace`;
      result += `\nYesterday: ${formatMoney(score.total_spend)} total spend, ${score.restaurant_count} restaurant visits, ${score.shopping_count} shopping purchases`;
      if (score.zero_spend) result += "\nZero-spend day!";
      return result;
    }

    case "get_recurring": {
      const rows = db.prepare(
        `SELECT merchant_name, description, avg_amount, last_amount, frequency, last_date, stream_type
         FROM recurring WHERE is_active = 1 ORDER BY stream_type, avg_amount DESC`
      ).all() as { merchant_name: string | null; description: string; avg_amount: number; last_amount: number; frequency: string; last_date: string; stream_type: string }[];
      if (rows.length === 0) return "No recurring transactions detected yet.";
      return rows.map(r => {
        const name = r.merchant_name || r.description;
        const arrow = r.stream_type === "inflow" ? "+" : "-";
        return `${arrow} ${name}: ${formatMoney(Math.abs(r.avg_amount))} (${r.frequency.toLowerCase()}, last: ${r.last_date})`;
      }).join("\n");
    }

    case "get_alerts": {
      const alerts = generateAlerts(db);
      if (alerts.length === 0) return "No active alerts. Everything looks good!";
      return alerts.map(a => `${a.severity === "critical" ? "\u{1F534}" : a.severity === "warning" ? "\u{1F7E1}" : "\u2139\uFE0F"} ${a.message}`).join("\n");
    }

    case "save_memory": {
      saveMemory(db, toolInput.content, toolInput.category || "general");
      return `Remembered: "${toolInput.content}"`;
    }

    case "get_memories": {
      const memories = getMemories(db);
      if (memories.length === 0) return "No memories saved yet.";
      return memories.map(m => `[${m.category}] ${m.content} (saved ${m.created_at})`).join("\n");
    }

    // --- New: Income & Search ---

    case "get_income": {
      const now = new Date();
      const start = toolInput.start_date || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      const end = toolInput.end_date || now.toISOString().slice(0, 10);
      const sources = getIncome(db, start, end);
      if (sources.length === 0) return `No income found from ${start} to ${end}.`;
      const total = sources.reduce((s, r) => s + r.total, 0);
      let result = `Income ${start} to ${end}: ${formatMoney(total)} total\n\n`;
      result += sources.map(s => `${s.source}: ${formatMoney(s.total)} (${s.count} deposits)`).join("\n");
      return result;
    }

    case "search_transactions": {
      const results = searchTransactions(db, toolInput.query, toolInput.limit);
      if (results.length === 0) return `No transactions found matching "${toolInput.query}".`;
      return results.map(t => `${t.date} | ${t.name}${t.merchant_name ? ` (${t.merchant_name})` : ""} | ${formatMoney(t.amount)} | ${categoryLabel(t.category)}`).join("\n");
    }

    case "categorize_transaction": {
      const updates: string[] = ["category = ?"];
      const params: any[] = [toolInput.category];
      if (toolInput.subcategory) {
        updates.push("subcategory = ?");
        params.push(toolInput.subcategory);
      }
      params.push(toolInput.transaction_id);
      const info = db.prepare(`UPDATE transactions SET ${updates.join(", ")} WHERE transaction_id = ?`).run(...params);
      if (info.changes === 0) return `Transaction ${toolInput.transaction_id} not found.`;
      return `Transaction recategorized to ${categoryLabel(toolInput.category)}.`;
    }

    // --- New: Analysis ---

    case "cash_flow": {
      const now = new Date();
      const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const start = toolInput.start_date || threeMonthsAgo.toISOString().slice(0, 10);
      const end = toolInput.end_date || now.toISOString().slice(0, 10);
      const cf = getCashFlow(db, start, end);
      let result = `Cash Flow ${start} to ${end}:\n`;
      result += `Income: ${formatMoney(cf.income)} | Expenses: ${formatMoney(cf.expenses)} | Net: ${formatMoney(cf.net)}`;
      result += `\nSavings rate: ${cf.savingsRate}%`;
      if (cf.monthly.length > 1) {
        result += `\n\nMonthly breakdown:`;
        for (const m of cf.monthly) {
          result += `\n${m.month}: Income ${formatMoney(m.income)} | Expenses ${formatMoney(m.expenses)} | Net ${formatMoney(m.net)}`;
        }
      }
      return result;
    }

    case "forecast_balance": {
      const fc = forecastBalance(db, toolInput.account_id, toolInput.months || 6);
      let result = `Current balance: ${formatMoney(fc.currentBalance)}`;
      result += `\nAvg monthly inflow: ${formatMoney(fc.avgMonthlyInflow)} | Avg outflow: ${formatMoney(fc.avgMonthlyOutflow)}`;
      result += `\n\nProjections:`;
      for (const p of fc.projections) {
        result += `\n${p.month}: ${formatMoney(p.projected)}`;
      }
      return result;
    }

    case "compare_spending": {
      const cmp = compareSpending(db, toolInput.period1_start, toolInput.period1_end, toolInput.period2_start, toolInput.period2_end);
      let result = `Period 1 (${toolInput.period1_start} to ${toolInput.period1_end}): ${formatMoney(cmp.period1Total)}`;
      result += `\nPeriod 2 (${toolInput.period2_start} to ${toolInput.period2_end}): ${formatMoney(cmp.period2Total)}`;
      result += `\nDifference: ${cmp.difference >= 0 ? "+" : ""}${formatMoney(cmp.difference)} (${cmp.pctChange >= 0 ? "+" : ""}${cmp.pctChange}%)`;
      if (cmp.categories.length > 0) {
        result += `\n\nBy category:`;
        for (const c of cmp.categories) {
          const arrow = c.diff > 0 ? "+" : "";
          result += `\n${categoryLabel(c.category)}: ${formatMoney(c.period1)} → ${formatMoney(c.period2)} (${arrow}${formatMoney(c.diff)})`;
        }
      }
      return result;
    }

    case "get_net_worth_trend": {
      const trend = getNetWorthTrend(db, toolInput.limit || 30);
      if (trend.length === 0) return "No net worth history available yet.";
      let result = `Net worth trend (${trend.length} data points):\n`;
      result += trend.map(t => `${t.date}: ${formatMoney(t.net_worth)} (assets: ${formatMoney(t.assets)}, liabilities: ${formatMoney(t.liabilities)})`).join("\n");
      if (trend.length >= 2) {
        const first = trend[0].net_worth;
        const last = trend[trend.length - 1].net_worth;
        const change = last - first;
        result += `\n\nChange over period: ${change >= 0 ? "+" : ""}${formatMoney(change)}`;
      }
      return result;
    }

    case "get_monthly_savings": {
      const savings = getMonthlySavings(db);
      if (!savings.baselineMonth) return "Not enough data to compare savings yet. Need at least one full month of transaction history.";
      let result = `Monthly savings vs ${savings.baselineMonth} baseline:`;
      result += `\nBaseline pace (${savings.daysCompared} days): ${formatMoney(savings.baselinePace)}`;
      result += `\nCurrent pace: ${formatMoney(savings.currentPace)}`;
      result += `\n${savings.saved >= 0 ? "Saved" : "Over by"}: ${formatMoney(Math.abs(savings.saved))}`;
      return result;
    }

    // --- New: Investments ---

    case "get_portfolio": {
      const port = getPortfolio(db);
      if (port.holdings.length === 0) return "No investment holdings found.";
      let result = `Portfolio: ${formatMoney(port.totalValue)} total value`;
      result += ` | Cost basis: ${formatMoney(port.totalCostBasis)} | Gain/Loss: ${port.totalGainLoss >= 0 ? "+" : ""}${formatMoney(port.totalGainLoss)}`;
      result += `\n\nHoldings:`;
      for (const h of port.holdings) {
        result += `\n${h.ticker || h.security} (${h.account}): ${formatMoney(h.value)} | ${h.quantity} shares | G/L: ${h.gainLoss >= 0 ? "+" : ""}${formatMoney(h.gainLoss)}`;
      }
      return result;
    }

    case "investment_performance": {
      const perf = getInvestmentPerformance(db);
      if (perf.holdings.length === 0) return "No investment holdings found.";
      let result = `Total return: ${perf.totalReturn >= 0 ? "+" : ""}${formatMoney(perf.totalReturn)} (${perf.totalReturnPct >= 0 ? "+" : ""}${perf.totalReturnPct}%)`;
      result += `\n\nBy holding:`;
      for (const h of perf.holdings) {
        result += `\n${h.ticker || h.security}: ${formatMoney(h.value)} (cost: ${formatMoney(h.costBasis)}, return: ${h.returnPct >= 0 ? "+" : ""}${h.returnPct}%)`;
      }
      return result;
    }

    // --- New: Debts ---

    case "get_debts": {
      const d = getDebts(db);
      if (d.debts.length === 0) return "No debts found.";
      let result = `Total debt: ${formatMoney(d.totalDebt)}\n`;
      for (const debt of d.debts) {
        result += `\n${debt.name}: ${formatMoney(debt.balance)}`;
        if (debt.rate > 0) result += ` @ ${debt.rate}% APR`;
        if (debt.minPayment > 0) result += ` | Min: ${formatMoney(debt.minPayment)}/mo`;
        if (debt.nextDue) result += ` | Next due: ${debt.nextDue}`;
      }
      return result;
    }

    case "calculate_debt_payoff": {
      const d = getDebts(db);
      if (d.debts.length === 0) return "No debts found.";
      const strategy = String(toolInput.strategy || "avalanche");
      const extraMonthly = Number(toolInput.extra_monthly || 0);
      const normalizedDebts = d.debts.map((debt, idx) => ({
        id: `debt-${idx + 1}`,
        name: debt.name,
        balance: debt.balance,
        aprPct: debt.rate || 0,
        minPayment: debt.minPayment || 0,
      }));
      const comparison = compareDebtPayoffStrategies({
        debts: normalizedDebts,
        extraMonthly,
        includeMinimum: strategy === "minimum",
      });
      const selected = comparison.strategies.find(s => s.strategy === strategy) || comparison.strategies[0];

      let result = `Debt payoff simulation (${selected.strategy} strategy, ${formatMoney(extraMonthly)} extra/mo):\n`;
      result += `Total debt: ${formatMoney(d.totalDebt)}\n`;
      result += selected.monthsToDebtFree == null
        ? `Debt-free horizon: not reached\n`
        : `Debt-free horizon: ${selected.monthsToDebtFree} months (${selected.debtFreeDate})\n`;
      result += `Total interest: ${formatMoney(selected.totalInterestPaid)}\n`;
      result += `Payoff order: ${selected.payoffOrder.join(" -> ")}`;
      if (selected.warnings.length > 0) {
        result += `\nWarnings: ${selected.warnings.join(" | ")}`;
      }
      return result;
    }

    case "compare_debt_payoff_strategies": {
      const d = getDebts(db);
      if (d.debts.length === 0) return "No debts found.";
      const extraMonthly = Number(toolInput.extra_monthly || 0);
      const rawCustom = Array.isArray(toolInput.custom_order) ? toolInput.custom_order.map(String) : [];
      const normalizedDebts = d.debts.map((debt, idx) => ({
        id: `debt-${idx + 1}`,
        name: debt.name,
        balance: debt.balance,
        aprPct: debt.rate || 0,
        minPayment: debt.minPayment || 0,
      }));
      const customOrder = rawCustom
        .map((label: string) => {
          const byId = normalizedDebts.find(d => d.id.toLowerCase() === label.toLowerCase());
          if (byId) return byId.id;
          const byName = normalizedDebts.find(d => d.name.toLowerCase() === label.toLowerCase());
          return byName?.id || null;
        })
        .filter(Boolean) as string[];

      const comparison = compareDebtPayoffStrategies({
        debts: normalizedDebts,
        extraMonthly,
        includeMinimum: Boolean(toolInput.include_minimum),
        customOrder,
      });

      let result = `Debt strategy comparison (${formatMoney(extraMonthly)} extra/mo):\n`;
      for (const strategy of comparison.strategies) {
        const horizon = strategy.monthsToDebtFree == null
          ? "not paid off"
          : `${strategy.monthsToDebtFree} mo (${strategy.debtFreeDate})`;
        result += `\n${strategy.strategy.toUpperCase()}: ${horizon}, interest ${formatMoney(strategy.totalInterestPaid)}`;
      }

      const sortable = comparison.strategies.filter(s => s.monthsToDebtFree != null);
      if (sortable.length > 0) {
        const best = [...sortable].sort((a, b) => a.totalInterestPaid - b.totalInterestPaid)[0];
        result += `\n\nLowest interest strategy: ${best.strategy.toUpperCase()} (${formatMoney(best.totalInterestPaid)})`;
      }
      if (customOrder.length > 0) {
        const resolved = customOrder
          .map(id => normalizedDebts.find(d => d.id === id)?.name || id)
          .join(" -> ");
        result += `\nCustom priority used: ${resolved}`;
      }
      return result;
    }

    case "calculate_credit_card_payoff": {
      const payoff = calculateCreditCardPayoff({
        balance: toolInput.balance,
        apr: toolInput.apr,
        monthlyPayment: toolInput.monthly_payment,
        targetMonths: toolInput.target_months,
        minimumPaymentPercent: toolInput.minimum_payment_percent,
        minimumPaymentFloor: toolInput.minimum_payment_floor,
        newMonthlyCharges: toolInput.new_monthly_charges,
        promotionalApr: toolInput.promotional_apr,
        promotionalMonths: toolInput.promotional_months,
        maxMonths: toolInput.max_months,
        fees: {
          monthlyFee: toolInput.fees?.monthly_fee,
          oneTimeFee: toolInput.fees?.one_time_fee,
        },
      });

      let result = `Credit-card payoff simulation for ${formatMoney(toolInput.balance)} at ${(Number(toolInput.apr) * 100).toFixed(2)}% APR`;
      if (payoff.monthsToPayoff == null) {
        result += `\nPayoff horizon: not paid off in simulation window`;
      } else {
        result += `\nPayoff horizon: ${payoff.monthsToPayoff} months`;
      }
      result += `\nTotal paid: ${formatMoney(payoff.totalPaid)} | Interest: ${formatMoney(payoff.totalInterestPaid)}`;
      if (payoff.requiredMonthlyPayment != null) {
        result += `\nRequired monthly payment for target: ${formatMoney(payoff.requiredMonthlyPayment)}`;
      }
      result += `\nFinal payment: ${formatMoney(payoff.finalPayment)}`;
      if (payoff.warnings.length > 0) {
        result += `\nWarnings:`;
        for (const warning of payoff.warnings) {
          result += `\n- ${warning}`;
        }
      }

      const preview = payoff.schedule.slice(0, 6);
      if (preview.length > 0) {
        result += `\n\nFirst months:`;
        for (const row of preview) {
          result += `\nM${row.month}: start ${formatMoney(row.startingBalance)}, interest ${formatMoney(row.interestCharged)}, pay ${formatMoney(row.payment)}, end ${formatMoney(row.endingBalance)}`;
        }
      }

      return result;
    }

    case "get_bnpl_pressure": {
      const pressure = getBnplPressure(db, { days: toolInput.days || 90 });
      if (pressure.activePlanCount === 0) return "No active BNPL plans tracked yet.";
      let result = `BNPL pressure: ${pressure.activePlanCount} active plan${pressure.activePlanCount === 1 ? "" : "s"}, ${formatMoney(pressure.remainingBnpl)} remaining`;
      result += `\nWindows: ${pressure.windows.map(w => `${w.days}d ${formatMoney(w.amount)}`).join(" | ")}`;
      result += `\n\nMonthly load:`;
      for (const month of pressure.monthly) {
        result += `\n${month.month}: BNPL ${formatMoney(month.bnplAmount)} | fixed obligations ${formatMoney(month.fixedObligationLoad)} | total ${formatMoney(month.totalObligationLoad)}`;
      }
      if (pressure.nextInstallments.length > 0) {
        result += `\n\nNext installments:`;
        for (const item of pressure.nextInstallments) {
          const label = item.provider || item.merchant || item.itemName;
          result += `\n${item.dueDate}: ${formatMoney(item.amount)} — ${label} (${item.itemName})`;
        }
      }
      if (pressure.collisions.length > 0) {
        result += `\n\nPayment collisions:`;
        for (const collision of pressure.collisions) {
          result += `\n${collision.date}: BNPL ${formatMoney(collision.bnplAmount)} plus ${formatMoney(collision.otherAmount)} other bills (${collision.names.join(", ")})`;
        }
      }
      return result;
    }

    case "get_bnpl_ledger": {
      const ledger = getBnplLedger(db, { days: toolInput.days || 90 });
      if (ledger.length === 0) return "No scheduled BNPL installments in that window.";
      return ledger.map(item => {
        const label = item.provider || item.merchant || item.itemName;
        return `${item.dueDate} | ${formatMoney(item.amount)} | ${label} | #${item.installmentNumber} ${item.itemName}`;
      }).join("\n");
    }

    case "add_bnpl_plan": {
      const planId = createBnplPlan(db, {
        itemName: toolInput.item_name,
        provider: toolInput.provider,
        merchant: toolInput.merchant,
        totalAmount: toolInput.total_amount,
        remainingAmount: toolInput.remaining_amount,
        installmentAmount: toolInput.installment_amount,
        installmentCount: Math.round(toolInput.installment_count),
        nextPaymentDate: toolInput.next_payment_date,
        frequencyDays: toolInput.frequency_days,
        note: toolInput.note,
      });
      return `BNPL plan added to the pressure ledger as #${planId}.`;
    }

    case "evaluate_purchase": {
      const result = evaluatePurchase(db, {
        itemName: toolInput.item_name,
        price: toolInput.price,
        category: toolInput.category,
        merchant: toolInput.merchant,
        paymentMode: toolInput.payment_mode === "bnpl" ? "bnpl" : "cash",
        urgency: ["low", "normal", "high"].includes(toolInput.urgency) ? toolInput.urgency : "normal",
        expectedUsesPerMonth: toolInput.expected_uses_per_month,
        expectedMonths: toolInput.expected_months,
        rentCost: toolInput.rent_cost,
        installmentCount: toolInput.installment_count,
        installmentAmount: toolInput.installment_amount,
        downPayment: toolInput.down_payment,
        installmentEveryDays: toolInput.installment_every_days,
      });
      const id = toolInput.save === false ? null : savePurchaseConsultation(db, result);
      let text = `Purchase consult${id ? ` #${id}` : ""}: ${result.recommendation.toUpperCase()} (${result.utilityScore}/100 utility, ${result.confidence} confidence)`;
      text += `\nItem: ${result.input.itemName} | Price: ${formatMoney(result.input.price)} | Category: ${result.input.category || "uncategorized"}`;
      text += `\nLiquidity: cash ${formatMoney(result.liquidity.cashOnHand)}, cash after purchase ${formatMoney(result.liquidity.cashAfterPurchase)}`;
      if (result.liquidity.emergencyBufferMonthsAfterPurchase !== null) {
        text += `, buffer ${result.liquidity.emergencyBufferMonthsAfterPurchase.toFixed(1)} months`;
      }
      text += `\nBNPL/installment pressure: 30d ${formatMoney(result.pressure.combined30)} | 60d ${formatMoney(result.pressure.combined60)} | 90d ${formatMoney(result.pressure.combined90)}`;
      text += `\nValue: ${result.value.valuePerUse === null ? "unknown" : `${formatMoney(result.value.valuePerUse)} per ${result.value.metric}`} over ${result.value.expectedUses} expected ${result.value.metric}${result.value.expectedUses === 1 ? "" : "s"}`;
      text += `\nSavings delay: ${result.savingsDelayDays === null ? "unbounded" : `${result.savingsDelayDays} days`}`;
      text += `\nScores: liquidity ${result.scores.liquidity}, cash pressure ${result.scores.cashPressure}, value ${result.scores.value}, impulse ${result.scores.impulse}`;
      text += `\nRationale:\n${result.rationale.map(line => `- ${line}`).join("\n")}`;
      text += `\nImpulse guard:\n${result.impulseGuard.map(line => `- ${line}`).join("\n")}`;
      return text;
    }

    case "record_purchase_decision": {
      recordPurchaseDecision(db, toolInput.consultation_id, toolInput.decision, toolInput.note);
      return `Recorded purchase decision for consultation #${toolInput.consultation_id}: ${toolInput.decision}`;
    }

    case "log_asset_usage": {
      const id = logAssetUsage(db, {
        assetName: toolInput.asset_name,
        category: toolInput.category,
        purchasePrice: toolInput.purchase_price,
        usageMetric: toolInput.usage_metric,
        quantity: toolInput.quantity,
        usedAt: toolInput.used_at,
        note: toolInput.note,
      });
      const summary = getAssetVpu(db, toolInput.asset_name);
      if (!summary) return `Usage logged as #${id}.`;
      return `Usage logged as #${id}. ${summary.assetName}: ${summary.totalQuantity} ${summary.usageMetric}${summary.totalQuantity === 1 ? "" : "s"} total${summary.costPerUnit !== null ? `, ${formatMoney(summary.costPerUnit)} per ${summary.usageMetric}` : ""}.`;
    }

    case "get_asset_vpu": {
      const summaries = toolInput.asset_name
        ? [getAssetVpu(db, toolInput.asset_name)].filter(Boolean) as NonNullable<ReturnType<typeof getAssetVpu>>[]
        : getRecentAssetVpu(db, toolInput.limit || 10);
      if (summaries.length === 0) return "No asset usage logged yet.";
      return summaries.map(s => {
        const cost = s.costPerUnit === null ? "unknown" : `${formatMoney(s.costPerUnit)} per ${s.usageMetric}`;
        return `${s.assetName}: ${s.totalQuantity} ${s.usageMetric}${s.totalQuantity === 1 ? "" : "s"} across ${s.useCount} log${s.useCount === 1 ? "" : "s"} | cost: ${cost}`;
      }).join("\n");
    }

    case "get_strategic_friction": {
      const rawStatus = toolInput.status || "active";
      const status = ["active", "resolved", "expired", "dismissed", "all"].includes(rawStatus) ? rawStatus : "active";
      const commitments = getFrictionCommitments(db, {
        status,
        dueWithinDays: toolInput.due_within_days,
      });
      if (commitments.length === 0) return "No matching strategic friction commitments.";
      return commitments.map(c =>
        `#${c.id} ${c.type} (${c.status}) due ${c.dueAt}\n${c.itemName} ${formatMoney(c.price)} — consult #${c.consultationId}, ${c.recommendation}\n${c.prompt}`
      ).join("\n\n");
    }

    case "resolve_strategic_friction": {
      const rawStatus = toolInput.status || "resolved";
      const status = ["resolved", "expired", "dismissed"].includes(rawStatus) ? rawStatus : "resolved";
      resolveFrictionCommitment(db, toolInput.commitment_id, toolInput.resolution, status);
      return `Strategic friction commitment #${toolInput.commitment_id} marked ${status}.`;
    }

    // --- New: Context ---

    case "update_context": {
      if (toolInput.section) {
        const sectionContent = toolInput.content || toolInput.updates || "";
        replaceContextSection(toolInput.section, sectionContent);
        return `Context section "${toolInput.section}" updated.`;
      }
      // Fallback: append mode
      const current = readContext();
      const updates = toolInput.updates || toolInput.content || "";
      const updated = current
        ? `${current}\n\n---\n_Updated ${new Date().toISOString().slice(0, 10)}_: ${updates}`
        : updates;
      writeContext(updated);
      return `Context updated: ${updates.slice(0, 100)}${updates.length > 100 ? "..." : ""}`;
    }

    // --- New: Data modification ---

    case "delete_budget": {
      const info = db.prepare(`DELETE FROM budgets WHERE category = ?`).run(toolInput.category);
      if (info.changes === 0) return `No budget found for category "${toolInput.category}".`;
      return `Budget for ${categoryLabel(toolInput.category)} deleted.`;
    }

    case "delete_goal": {
      const info = db.prepare(`DELETE FROM goals WHERE name = ?`).run(toolInput.name);
      if (info.changes === 0) return `No goal found with name "${toolInput.name}".`;
      return `Goal "${toolInput.name}" deleted.`;
    }

    case "update_goal_progress": {
      const info = db.prepare(`UPDATE goals SET current_amount = ? WHERE name = ?`).run(toolInput.current_amount, toolInput.name);
      if (info.changes === 0) return `No goal found with name "${toolInput.name}".`;
      return `Goal "${toolInput.name}" updated to ${formatMoney(toolInput.current_amount)}.`;
    }

    case "label_transaction": {
      const updates: string[] = [];
      const params: any[] = [];
      if (toolInput.label) { updates.push("label = ?"); params.push(toolInput.label); }
      if (toolInput.note) { updates.push("note = ?"); params.push(toolInput.note); }
      if (updates.length === 0) return "Provide a label or note to add.";
      params.push(toolInput.transaction_id);
      const info = db.prepare(`UPDATE transactions SET ${updates.join(", ")} WHERE transaction_id = ?`).run(...params);
      if (info.changes === 0) return `Transaction ${toolInput.transaction_id} not found.`;
      return `Transaction labeled.`;
    }

    case "add_recat_rule": {
      const allowedFields = ["name", "merchant_name", "category", "subcategory"];
      if (!allowedFields.includes(toolInput.match_field)) {
        return `Invalid match_field "${toolInput.match_field}". Must be one of: ${allowedFields.join(", ")}`;
      }
      db.prepare(
        `INSERT INTO recategorization_rules (match_field, match_pattern, target_category, target_subcategory, label) VALUES (?, ?, ?, ?, ?)`
      ).run(toolInput.match_field, toolInput.match_pattern, toolInput.target_category, toolInput.target_subcategory || null, toolInput.label || null);
      return `Recategorization rule added: ${toolInput.match_field} matching "${toolInput.match_pattern}" → ${categoryLabel(toolInput.target_category)}`;
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
