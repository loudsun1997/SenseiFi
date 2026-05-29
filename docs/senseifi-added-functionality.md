# Sensei-Fi Added Functionality

This document tracks what was added on top of the Ray Finance fork.

Ray remains the finance data engine (Plaid, SQLite, transactions, budgets, goals, scoring, alerts). Sensei-Fi adds a decision layer focused on pre-purchase guidance, BNPL debt-drag visibility, and forward-looking analysis.

## 1) BNPL Cash Pressure Ledger

What was added:

- Active BNPL plan tracking (`Affirm`, `Klarna`, `Afterpay`, `Sezzle`, `Zip`, `PayPal Pay Later` patterns).
- Chronological installment ledger.
- 30/60/90 day pressure windows.
- Monthly obligation rollup.
- Payment collision detection versus recurring obligations.
- Mark-installment-paid workflow.
- Transaction scan for likely BNPL payments.

CLI commands:

```bash
ray bnpl
ray bnpl ledger
ray bnpl add "Wahoo KICKR" --total 899 --installments 4 --next 2026-06-15 --provider Affirm
ray bnpl paid <installment-id>
ray bnpl scan
```

Main code:

- `src/sensei/bnpl.ts`
- `src/ai/tools.ts`
- `src/cli/index.ts`
- `src/cli/commands.ts`

## 2) Purchase Consultant (Should I Buy This?)

What was added:

- Deterministic consult output: `buy`, `wait`, `rent`, `skip`.
- Liquidity audit and post-purchase cash impact.
- Emergency-buffer impact.
- BNPL pressure impact from candidate purchase.
- Savings-delay estimate.
- Utility score with component scores (liquidity, pressure, value, impulse).
- Saved consultations + decision logging.

CLI commands:

```bash
ray consult "MacBook Pro upgrade" --price 2499 --category electronics --urgency high
ray consult "Bike computer" --price 550 --bnpl --installments 4 --every 14
ray decision <consultation-id> wait --note "Waiting 48 hours."
```

Main code:

- `src/sensei/purchase-consultant.ts`
- `src/ai/tools.ts`
- `src/cli/index.ts`
- `src/cli/commands.ts`

## 3) VPU (Value-Per-Use) Modeling

What was added:

- Usage logging by asset.
- Flexible metric model (`mile`, `project`, `hour`, `use`, etc.).
- Cost-per-metric computation.
- Category usage signals that feed purchase consult forecasts.

CLI commands:

```bash
ray usage
ray usage "Gravel bike"
ray usage add "Gravel bike" --category cycling --metric mile --quantity 12 --price 2400
```

Main code:

- `src/sensei/vpu.ts`
- `src/sensei/purchase-consultant.ts`
- `src/ai/tools.ts`

## 4) Strategic Friction + Frugality Rewards

What was added:

- Follow-up commitments auto-created for non-`buy` recommendations.
- Cooldown prompts, rent-first prompts, and usage-audit prompts.
- Commitment resolution flow.
- Frugality event scoring/points metadata when users accept a nudge.

CLI commands:

```bash
ray friction
ray friction --status all
ray friction resolve <commitment-id> "I skipped it."
```

Main code:

- `src/sensei/strategic-friction.ts`
- `src/sensei/purchase-consultant.ts`
- `src/ai/tools.ts`

## 5) APR Promo-Term Modeling (0% Intro Windows)

What was added:

- Account-level APR promo terms table.
- Effective APR logic with promo window support:
  - active window -> promo APR (default 0)
  - after window -> post-promo APR (if provided)
  - fallback -> liability APR/default assumptions
- APR labels surfaced in GUI account snapshot.
- API for save/clear promo end date.

Main code:

- `src/db/schema.ts` (`liability_apr_terms`)
- `src/analysis/index.ts` (APR-aware debt ordering)
- `src/server.ts` (`/api/apr-terms`, APR snapshot fields)
- `src/public/app.html` (APR editor UI)

## 6) Financial Analysis Cockpit Models

What was added:

- Cash-flow forecast by paycheck cycle.
- Paycheck pressure map.
- Debt avalanche ordering.
- Future account-balance simulation.
- Recurring obligation calendar.
- Scenario simulation.
- True affordability signal.
- Tax-aware planning estimate.
- Investment allocation summary.
- Emergency-fund runway modeling.

Main code:

- `src/analysis/index.ts`
- `src/public/app.html`
- `src/server.ts` (`/api/analysis`, `/api/analyze`)

## 7) Web App Surface (GUI + Dedicated Chat)

What was added:

- Local web dashboard command: `ray gui`.
- Account linking/sync/manage flow in GUI.
- Plaid update flow ("add more accounts" for existing institution item).
- Dedicated chat page with streaming responses.
- Chat cancellation endpoint.
- Chat export endpoint (JSON/Markdown).

Main code:

- `src/server.ts`
- `src/public/app.html`
- `src/public/chat.html`
- `src/public/link.html`
- `src/plaid/link.ts`
- `src/plaid/sync.ts`

## 8) Debt/Payoff Simulators

### Credit-card payoff tool

What was added:

- Month-by-month credit-card payoff simulator.
- Minimum-payment rule support.
- Promo APR window support.
- Target payoff month support (required payment search).
- New charges + fee modeling.

Code:

- `src/sensei/credit-card-payoff.ts`
- `src/sensei/credit-card-payoff.test.ts`

AI tool:

- `calculate_credit_card_payoff`

### Multi-debt strategy comparison

What was added:

- Portfolio simulation for:
  - `minimum`
  - `avalanche`
  - `snowball`
  - `custom` priority
- Shared deterministic engine for strategy comparison.

Code:

- `src/sensei/debt-strategies.ts`
- `src/sensei/debt-strategies.test.ts`

AI tools:

- `compare_debt_payoff_strategies`
- `calculate_debt_payoff` (aligned to the shared strategy engine)

## 9) AI Tooling Integration

Key Sensei-specific tools now available to chat:

- `get_bnpl_pressure`
- `get_bnpl_ledger`
- `add_bnpl_plan`
- `evaluate_purchase`
- `record_purchase_decision`
- `log_asset_usage`
- `get_asset_vpu`
- `get_strategic_friction`
- `resolve_strategic_friction`
- `calculate_credit_card_payoff`
- `compare_debt_payoff_strategies`

Main code:

- `src/ai/tools.ts`
- `src/ai/agent.ts`
- `src/ai/system-prompt.ts`

## 10) Data Model Additions

New/extended tables used by Sensei-Fi:

- `bnpl_plans`
- `bnpl_installments`
- `purchase_consultations`
- `purchase_decisions`
- `asset_usage`
- `strategic_friction_events`
- `strategic_friction_commitments`
- `financial_analysis_runs`
- `financial_insights`
- `liability_apr_terms`

Main code:

- `src/db/schema.ts`
- `src/db/schema.test.ts`

## 11) Demo Fixture

What was added:

- Sensei-focused seeded demo with BNPL, consult history, VPU logs, and friction events.

Command:

```bash
ray demo-sensei --path <local-db-path>
```

Code:

- `src/demo/sensei-seed.ts`

## 12) Storage and "Knowledge" Behavior

Current architecture is local-first and deterministic:

- Persistent financial state: local SQLite (`DB_PATH`).
- LLM memory/context: local context + local conversation history.
- No graph database required.
- LLM does not replace the ledger; tools and analysis modules are source of truth.

## 13) Test Status

Current test command:

```bash
npm test
```

At latest update, suite passed with **132 tests**.

## Current Gaps / Next Steps

- Rebrand cleanup (still Ray names/paths in several places).
- Trial/subscription "trial necromancy" reminders are not fully implemented yet.
- Mobile/extension point-of-sale capture is still future work.
- Letta/LangGraph/PydanticAI/MCP architecture is not yet split into separate services.
