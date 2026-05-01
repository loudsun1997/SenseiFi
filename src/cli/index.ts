#!/usr/bin/env node
import { resolve } from "path";
import { homedir } from "os";

// --demo flag: use dedicated demo database (must run before config import)
const isDemoMode = process.argv.includes("--demo");
if (isDemoMode) {
  process.argv = process.argv.filter(a => a !== "--demo");
}

import { Command } from "commander";
import { createRequire } from "module";
import { config, isConfigured, useManaged, RAY_PROXY_BASE } from "../config.js";
import { helpScreen } from "./format.js";

// Override config for demo mode (demo DB is unencrypted)
if (isDemoMode) {
  config.dbPath = resolve(homedir(), ".ray", "data", "demo.db");
  config.dbEncryptionKey = "";
}

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

const program = new Command();

program
  .name("ray")
  .description("Personal finance AI assistant")
  .version(version)
  .addHelpCommand(false)
  .action(async () => {
    if (!isConfigured()) {
      console.log("Ray is not configured yet. Running setup...\n");
      const { runSetup } = await import("./setup.js");
      await runSetup();
      return;
    }
    const { startChat } = await import("./chat.js");
    await startChat();
  });

program
  .command("setup")
  .description("Configure Ray (API keys, preferences)")
  .action(async () => {
    const { runSetup } = await import("./setup.js");
    await runSetup();
  });

program
  .command("sync")
  .description("Sync transactions from linked banks")
  .action(async () => {
    ensureConfigured();
    const { runSync } = await import("./commands.js");
    await runSync();
  });

program
  .command("link")
  .description("Link a new financial account via Plaid")
  .action(async () => {
    ensureConfigured();
    if (!useManaged() && (!config.plaidClientId || !config.plaidSecret)) {
      console.error("Plaid credentials not configured. Run 'ray setup' to add them, or use a Ray API key for easy setup.");
      process.exit(1);
    }
    const { runLink } = await import("./commands.js");
    await runLink();
  });

program
  .command("add")
  .description("Add a manual account (home, car, crypto, etc.)")
  .action(async () => {
    ensureConfigured();
    const { runAdd } = await import("./commands.js");
    await runAdd();
  });

program
  .command("remove")
  .description("Remove a linked bank or manual account")
  .action(async () => {
    ensureConfigured();
    const { runRemove } = await import("./commands.js");
    await runRemove();
  });

program
  .command("accounts")
  .description("Show linked accounts and balances")
  .action(async () => {
    ensureConfigured();
    const { showAccounts } = await import("./commands.js");
    await showAccounts();
  });

program
  .command("status")
  .description("Show financial overview")
  .action(async () => {
    ensureConfigured();
    const { showStatus } = await import("./commands.js");
    showStatus();
  });

program
  .command("transactions")
  .description("Show recent transactions")
  .option("-n, --limit <number>", "Number of transactions", "20")
  .option("-c, --category <category>", "Filter by category")
  .option("-m, --merchant <name>", "Filter by merchant")
  .action(async (opts) => {
    ensureConfigured();
    const { showTransactions } = await import("./commands.js");
    showTransactions({ limit: Number(opts.limit), category: opts.category, merchant: opts.merchant });
  });

program
  .command("spending")
  .description("Show spending breakdown")
  .argument("[period]", "Period: this_month, last_month, last_30, last_90", "this_month")
  .action(async (period) => {
    ensureConfigured();
    const { showSpending } = await import("./commands.js");
    await showSpending(period);
  });

program
  .command("budgets")
  .description("Show budget statuses")
  .action(async () => {
    ensureConfigured();
    const { showBudgets } = await import("./commands.js");
    showBudgets();
  });

program
  .command("goals")
  .description("Show financial goals")
  .action(async () => {
    ensureConfigured();
    const { showGoals } = await import("./commands.js");
    showGoals();
  });

program
  .command("score")
  .description("Show daily financial score and streaks")
  .action(async () => {
    ensureConfigured();
    const { showScore } = await import("./commands.js");
    showScore();
  });

program
  .command("alerts")
  .description("Show financial alerts")
  .action(async () => {
    ensureConfigured();
    const { showAlerts } = await import("./commands.js");
    showAlerts();
  });

program
  .command("bills")
  .description("Show upcoming bills")
  .option("-d, --days <number>", "Number of days ahead", "7")
  .action(async (opts) => {
    ensureConfigured();
    const { showBills } = await import("./commands.js");
    showBills(Number(opts.days));
  });

program
  .command("consult")
  .description("Ask Sensei-Fi whether a purchase is worth it")
  .argument("<item>", "Item or purchase name")
  .requiredOption("--price <amount>", "Purchase price")
  .option("--category <name>", "Purchase category, e.g. cycling, software, tool")
  .option("--merchant <name>", "Merchant name")
  .option("--urgency <level>", "low, normal, or high", "normal")
  .option("--uses-per-month <number>", "Expected uses per month")
  .option("--months <number>", "Expected months of use")
  .option("--rent-cost <amount>", "Rental/borrow/test cost for comparison")
  .option("--bnpl", "Evaluate as a BNPL/installment purchase")
  .option("--installments <number>", "BNPL installment count")
  .option("--installment-amount <amount>", "BNPL installment amount")
  .option("--down-payment <amount>", "BNPL down payment")
  .option("--every <days>", "Days between BNPL installments", "14")
  .option("--no-save", "Do not save the consultation")
  .action(async (item, opts) => {
    ensureConfigured();
    const { runPurchaseConsult } = await import("./commands.js");
    runPurchaseConsult(item, opts);
  });

program
  .command("decision")
  .description("Record what you did after a purchase consult")
  .argument("<consultation-id>", "Consultation ID")
  .argument("<decision>", "buy, wait, rent, skip, or custom decision")
  .option("--note <text>", "Decision note")
  .action(async (consultationId, decision, opts) => {
    ensureConfigured();
    const { recordConsultDecision } = await import("./commands.js");
    recordConsultDecision(Number(consultationId), decision, opts.note);
  });

const usage = program
  .command("usage")
  .description("Track value-per-use for assets")
  .argument("[asset]", "Asset name")
  .option("-n, --limit <number>", "Number of assets to show", "10")
  .action(async (asset, opts) => {
    ensureConfigured();
    const { showAssetVpu } = await import("./commands.js");
    showAssetVpu(asset, Number(opts.limit));
  });

usage
  .command("add")
  .description("Log real-world usage for an asset")
  .argument("<asset>", "Asset name")
  .option("--category <name>", "Asset category, e.g. cycling, tool, software")
  .option("--price <amount>", "Purchase price/cost basis")
  .option("--metric <name>", "Usage metric, e.g. mile, project, hour, use")
  .option("--quantity <number>", "Usage quantity", "1")
  .option("--date <date>", "Usage date (YYYY-MM-DD)")
  .option("--note <text>", "Usage note")
  .action(async (asset, opts) => {
    ensureConfigured();
    const { addAssetUsage } = await import("./commands.js");
    addAssetUsage(asset, opts);
  });

const friction = program
  .command("friction")
  .description("Review active strategic friction commitments")
  .option("--status <status>", "active, resolved, expired, dismissed, all", "active")
  .option("--due-within <days>", "Only show commitments due within N days")
  .action(async (opts) => {
    ensureConfigured();
    const { showStrategicFriction } = await import("./commands.js");
    showStrategicFriction(opts);
  });

friction
  .command("resolve")
  .description("Resolve a strategic friction commitment")
  .argument("<commitment-id>", "Commitment ID from ray friction")
  .argument("<resolution>", "What happened")
  .option("--status <status>", "resolved, expired, dismissed", "resolved")
  .action(async (commitmentId, resolution, opts) => {
    ensureConfigured();
    const { resolveStrategicFriction } = await import("./commands.js");
    resolveStrategicFriction(Number(commitmentId), resolution, opts.status);
  });

const bnpl = program
  .command("bnpl")
  .description("Track BNPL installment pressure")
  .option("-d, --days <number>", "Number of days ahead", "90")
  .action(async (opts) => {
    ensureConfigured();
    const { showBnplPressure } = await import("./commands.js");
    showBnplPressure(Number(opts.days));
  });

bnpl
  .command("add")
  .description("Add a BNPL plan to the pressure ledger")
  .argument("<item>", "Item or purchase name")
  .requiredOption("--total <amount>", "Total purchase amount")
  .requiredOption("--installments <number>", "Number of remaining installments")
  .requiredOption("--next <date>", "Next payment date (YYYY-MM-DD)")
  .option("--provider <name>", "Provider, e.g. Affirm, Klarna, Afterpay")
  .option("--merchant <name>", "Merchant name")
  .option("--remaining <amount>", "Remaining amount if different from total")
  .option("--amount <amount>", "Installment amount if fixed")
  .option("--every <days>", "Days between installments", "14")
  .option("--purchase-date <date>", "Purchase date (YYYY-MM-DD)")
  .option("--note <text>", "Plan note")
  .action(async (item, opts) => {
    ensureConfigured();
    const { addBnplPlan } = await import("./commands.js");
    addBnplPlan(item, opts);
  });

bnpl
  .command("ledger")
  .description("Show the chronological BNPL installment ledger")
  .option("-d, --days <number>", "Number of days ahead", "90")
  .action(async (opts) => {
    ensureConfigured();
    const { showBnplLedger } = await import("./commands.js");
    showBnplLedger(Number(opts.days));
  });

bnpl
  .command("paid")
  .description("Mark a BNPL installment paid")
  .argument("<installment-id>", "Installment ID from bnpl ledger")
  .option("--date <date>", "Payment date (YYYY-MM-DD)")
  .option("--transaction <id>", "Linked transaction ID")
  .action(async (installmentId, opts) => {
    ensureConfigured();
    const { markBnplPaid } = await import("./commands.js");
    markBnplPaid(Number(installmentId), opts);
  });

bnpl
  .command("scan")
  .description("Scan transactions for likely BNPL providers")
  .option("-d, --days <number>", "Days of transaction history to scan", "180")
  .action(async (opts) => {
    ensureConfigured();
    const { scanBnplCandidates } = await import("./commands.js");
    scanBnplCandidates(Number(opts.days));
  });

program
  .command("recap")
  .description("Monthly spending recap")
  .argument("[period]", "Period: this_month, last_month", "last_month")
  .action(async (period) => {
    ensureConfigured();
    const { showRecap } = await import("./commands.js");
    showRecap(period);
  });

program
  .command("export")
  .description("Export user data (goals, budgets, memories, context) to a backup file")
  .argument("[path]", "Output file path", undefined)
  .action(async (path) => {
    ensureConfigured();
    const { runExport } = await import("./backup.js");
    runExport(path);
  });

program
  .command("import")
  .description("Restore user data from a backup file")
  .argument("<path>", "Backup file path")
  .action(async (path) => {
    ensureConfigured();
    const { runImport } = await import("./backup.js");
    runImport(path);
  });

program
  .command("billing")
  .description("Manage your Ray subscription")
  .action(async () => {
    ensureConfigured();
    if (!useManaged()) {
      console.log("You're using your own keys. No subscription to manage.");
      return;
    }
    const open = (await import("open")).default;
    console.log("Opening billing portal...");
    try {
      const resp = await fetch(`${RAY_PROXY_BASE}/stripe/portal`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${config.rayApiKey}`,
        },
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const msg = (() => { try { return JSON.parse(text).error; } catch { return text; } })();
        console.error(`Could not open billing portal (${resp.status}): ${msg || "unknown error"}`);
        return;
      }
      const { url } = await resp.json() as { url: string };
      // Only open URLs from trusted domains
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith("stripe.com") && !parsed.hostname.endsWith("rayfinance.app")) {
        console.error("Unexpected billing URL.");
      } else {
        await open(url);
      }
    } catch (err) {
      console.error("Could not open billing portal:", (err as Error).message);
    }
  });

program
  .command("update")
  .description("Update Ray to the latest version")
  .action(async () => {
    const { runUpdate } = await import("./updater.js");
    await runUpdate(version);
  });

program
  .command("doctor")
  .description("Check system health")
  .action(async () => {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor();
  });

program
  .command("demo")
  .description("Seed a demo database with realistic fake data")
  .action(async () => {
    const demoPath = resolve(homedir(), ".ray", "data", "demo.db");
    const { seedDemoDb } = await import("../demo/seed.js");
    seedDemoDb(demoPath);
  });


function ensureConfigured(): void {
  if (isDemoMode) return;
  if (!isConfigured()) {
    console.error("Ray is not configured. Run 'ray setup' first.");
    process.exit(1);
  }
}

// Custom help screen
program.configureHelp({
  formatHelp: () => helpScreen([
    { name: "setup", desc: "Configure Ray (API keys, preferences)" },
    { name: "link", desc: "Link a new financial account via Plaid" },
    { name: "add", desc: "Add a manual account (home, car, crypto, etc.)" },
    { name: "remove", desc: "Remove a linked bank or manual account" },
    { name: "sync", desc: "Sync transactions from linked banks" },
    { name: "accounts", desc: "Show linked accounts and balances" },
    { name: "status", desc: "Show financial overview" },
    { name: "transactions", desc: "Show recent transactions" },
    { name: "spending", desc: "Show spending breakdown" },
    { name: "budgets", desc: "Show budget statuses" },
    { name: "goals", desc: "Show financial goals" },
    { name: "score", desc: "Show daily financial score and streaks" },
    { name: "alerts", desc: "Show financial alerts" },
    { name: "bills", desc: "Show upcoming bills" },
    { name: "consult", desc: "Ask Sensei-Fi whether a purchase is worth it" },
    { name: "decision", desc: "Record a purchase consult outcome" },
    { name: "usage", desc: "Track value-per-use for assets" },
    { name: "friction", desc: "Review active strategic friction commitments" },
    { name: "bnpl", desc: "Track BNPL installment pressure" },
    { name: "recap", desc: "Monthly spending recap" },
    { name: "export", desc: "Export data to a backup file" },
    { name: "import", desc: "Restore data from a backup file" },
    { name: "billing", desc: "Manage your Ray subscription" },
    { name: "update", desc: "Update Ray to the latest version" },
    { name: "doctor", desc: "Check system health" },
    { name: "demo", desc: "Seed a demo database with fake data" },
  ]),
});

import("./updater.js").then(m => m.checkForUpdate(version)).catch(() => {});

program.parse();
