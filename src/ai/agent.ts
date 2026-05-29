import type Database from "libsql";
import { config, useManaged } from "../config.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";
import { getConversationHistory, saveMessage } from "./memory.js";
import { logToolCall } from "./audit.js";
import { redact, unredact } from "./redactor.js";
import { createProvider } from "./providers/index.js";
import type { NormalizedMessage, NormalizedToolResult, NormalizedContentBlock } from "./provider.js";
import { getNetWorth } from "../queries/index.js";
import { getLatestFinancialAnalysis } from "../analysis/index.js";
import type { ChatSurface } from "./system-prompt.js";

const provider = createProvider();

const MAX_TOOL_STEPS = 10;

function supportsThinking(model: string): boolean {
  return /sonnet-4|opus-4/i.test(model);
}

/** Human-readable labels for tool calls shown in the spinner */
export const TOOL_LABELS: Record<string, string> = {
  get_net_worth: "Checking net worth",
  get_accounts: "Reviewing accounts",
  get_transactions: "Looking at transactions",
  get_spending_summary: "Analyzing spending",
  get_budgets: "Reviewing budgets",
  set_budget: "Setting budget",
  get_goals: "Checking goals",
  set_goal: "Setting goal",
  get_score: "Calculating score",
  get_recurring: "Finding recurring charges",
  get_alerts: "Checking alerts",
  get_bnpl_pressure: "Checking BNPL pressure",
  get_bnpl_ledger: "Reading BNPL ledger",
  add_bnpl_plan: "Adding BNPL plan",
  compare_debt_payoff_strategies: "Comparing debt strategies",
  calculate_credit_card_payoff: "Simulating card payoff",
  evaluate_purchase: "Running purchase consult",
  record_purchase_decision: "Recording purchase decision",
  log_asset_usage: "Logging asset usage",
  get_asset_vpu: "Checking value per use",
  get_strategic_friction: "Checking friction commitments",
  resolve_strategic_friction: "Resolving friction commitment",
  save_memory: "Remembering that",
  update_context: "Updating your profile",
};

export type ProgressCallback = (event: {
  phase: "tool" | "responding";
  toolName?: string;
  toolCount: number;
  elapsedMs: number;
}) => void;

/** Thrown by handleMessage when the caller aborts via AbortSignal */
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

export interface HandleMessageOptions {
  surface?: ChatSurface;
}

export async function handleMessage(
  db: Database.Database,
  userMessage: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  options: HandleMessageOptions = {},
): Promise<string> {
  // Save incoming message
  saveMessage(db, "user", userMessage);

  // Load conversation context, truncated to fit token budget
  const rawHistory = getConversationHistory(db, 30);
  const MAX_HISTORY_CHARS = 24_000; // ~6k tokens, leaves room for system prompt + response
  let historyChars = 0;
  const history = [];
  for (let i = rawHistory.length - 1; i >= 0; i--) {
    historyChars += rawHistory[i].content.length;
    if (historyChars > MAX_HISTORY_CHARS) break;
    history.unshift(rawHistory[i]);
  }

  // Build system prompt and redact PII before sending to API
  const systemPrompt = redact(buildSystemPrompt(db, options.surface || "cli"));

  // Build messages array from history, redacting PII
  const messages: NormalizedMessage[] = history.map(h => ({
    role: h.role as "user" | "assistant",
    content: redact(h.content),
  }));

  // Ensure last message is the current user message
  if (messages.length === 0 || messages[messages.length - 1].content !== userMessage) {
    messages.push({ role: "user", content: redact(userMessage) });
  }

  // Extended thinking config — only for providers that support it
  const useThinking = config.thinkingBudget > 0
    && provider.supportsThinking
    && supportsThinking(config.model);

  const throwIfAborted = () => {
    if (signal?.aborted) throw new AbortedError();
  };

  try {
    throwIfAborted();

    // Initial API call
    let response = await provider.sendMessage({
      model: config.model,
      maxTokens: useThinking ? 16000 : 4096,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
      thinking: useThinking
        ? { type: "enabled", budget_tokens: config.thinkingBudget }
        : undefined,
      signal,
    });

    // Agentic tool loop
    const startTime = Date.now();
    let toolCount = 0;

    while (response.stopReason === "tool_use" && toolCount < MAX_TOOL_STEPS) {
      throwIfAborted();
      messages.push({ role: "assistant", content: response.content });

      const toolResults: NormalizedToolResult[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolCount++;
          onProgress?.({
            phase: "tool",
            toolName: block.name,
            toolCount,
            elapsedMs: Date.now() - startTime,
          });
          const result = await executeTool(db, block.name, block.input);
          logToolCall(db, block.name, block.input, result, response.usage?.output_tokens);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: redact(result),
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      onProgress?.({
        phase: "responding",
        toolCount,
        elapsedMs: Date.now() - startTime,
      });

      throwIfAborted();

      response = await provider.sendMessage({
        model: config.model,
        maxTokens: useThinking ? 16000 : 4096,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
        thinking: useThinking
          ? { type: "enabled", budget_tokens: config.thinkingBudget }
          : undefined,
        signal,
      });
    }

    // Extract text response, restore PII for display
    const textBlocks = response.content.filter((b): b is Extract<NormalizedContentBlock, { type: "text" }> => b.type === "text");
    const responseText = unredact(textBlocks.map(b => b.text).join("\n")).trim();
    const shouldForceGrounded = shouldForceGroundedFallback(userMessage, responseText, toolCount);
    const finalText = (!responseText || shouldForceGrounded)
      ? buildDeterministicFallback(db, userMessage)
      : responseText;

    // Save assistant response
    saveMessage(db, "assistant", finalText);

    return finalText;
  } catch (error: any) {
    if (error instanceof AbortedError || error?.name === "AbortError" || signal?.aborted) {
      throw new AbortedError();
    }
    if (error.status === 403) {
      if (useManaged()) {
        return "Your API key was rejected. This usually means your subscription is inactive. Run `ray billing` to check your payment status, or `ray setup` to reconfigure.";
      }
      return "Your API key was rejected (403 Forbidden). Run `ray setup` to reconfigure your credentials.";
    }
    if (error.status === 401) {
      return "Invalid API key. Run `ray setup` to reconfigure your credentials.";
    }
    if (error.status === 429) {
      return "Rate limited. Wait a moment and try again.";
    }
    const safeMessage = error.status
      ? `API error (${error.status}): ${error.message || ""}`
      : error.message || "internal error";
    console.error("AI error:", safeMessage);
    return buildDeterministicFallback(db, userMessage);
  }
}

function buildDeterministicFallback(db: Database.Database, userMessage: string): string {
  const txCountRow = db.prepare(`SELECT COUNT(*) as count FROM transactions`).get() as { count: number };
  const txCount = Number(txCountRow?.count || 0);
  if (txCount === 0) {
    return "I don't see synced transactions yet. Run a fresh sync, then I can give a grounded evaluation.";
  }

  const nw = getNetWorth(db);
  const analysis = getLatestFinancialAnalysis(db);
  const isFactVerification = /one info|one fact|verify/i.test(userMessage);
  const firstFact = `Net worth is ${formatMoney(nw.net_worth)} with cash ${formatMoney(nw.cash)} and debt ${formatMoney(nw.credit_debt + nw.mortgage)}.`;

  if (!analysis) {
    return `${firstFact} I can pull deeper recommendations after you run Analyze once in the dashboard.`;
  }

  const topDebt = analysis.debtAvalanche?.payoffOrder?.[0];
  const lines = [
    firstFact,
    `True affordability is ${analysis.trueAffordability.affordabilityBand}; safe-to-spend today is ${formatMoney(analysis.trueAffordability.safeToSpendToday)}.`,
    `Emergency runway is ${analysis.emergencyFundRunway.runwayMonths.toFixed(1)} months.`,
  ];

  if (topDebt) {
    lines.push(`Highest-priority debt is ${topDebt.accountName} at ${topDebt.apr}% APR.`);
  }

  if (isFactVerification) {
    return lines[0];
  }

  if (/top 3|focus goals|90 days|evaluation|overview|my situation|financial status|based on my/i.test(userMessage.toLowerCase())) {
    const goals: string[] = [];
    if (topDebt) goals.push(`1. Attack ${topDebt.accountName} first: direct extra payments to the ${topDebt.apr}% APR balance while paying minimums on everything else.`);
    goals.push(`2. Keep discretionary spend under ${formatMoney(Math.max(0, analysis.trueAffordability.safeToSpendToday * 0.12))} total over the next 90 days to preserve your cash-pressure buffer.`);
    goals.push(`3. Run weekly check-ins: Sync + Analyze once a week and review any obligations due in the next 14 days.`);
    lines.push("Top 3 focus goals for the next 90 days:");
    lines.push(...goals);
    return lines.join("\n");
  }

  lines.push("If you want, I can break this into top 3 focus goals for the next 90 days.");
  return lines.join("\n");
}

function shouldForceGroundedFallback(userMessage: string, responseText: string, toolCount: number): boolean {
  if (toolCount > 0) return false;
  const prompt = userMessage.toLowerCase();
  const asksForGroundedFact = /one info|one fact|verify|context|financial status|overview|evaluation|my situation|based on my/i.test(prompt);
  if (!asksForGroundedFact) return false;

  const answer = responseText.toLowerCase();
  const looksGeneric =
    /what kind of information|please let me know|for example|i can certainly|i can help you|which area|please provide more details/.test(answer);
  const hasConcreteNumbers = /\$\d|%\b|\b\d{1,3}(,\d{3})*(\.\d+)?\b/.test(responseText);
  return looksGeneric || !hasConcreteNumbers;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value || 0);
}
