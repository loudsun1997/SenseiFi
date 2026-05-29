import express from "express";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { createAccountSelectionUpdateLinkToken, createLinkToken, exchangeToken } from "./plaid/link.js";
import { refreshProducts, syncBalances, syncTransactions, syncInvestments, syncInvestmentTransactions, syncLiabilities, syncRecurring, isProductNotSupported } from "./plaid/sync.js";
import { plaidClient } from "./plaid/client.js";
import { getCountryCodes } from "./plaid/link.js";
import { decryptPlaidToken, encryptPlaidToken } from "./db/encryption.js";
import { config } from "./config.js";
import { getDb } from "./db/connection.js";
import { runDailySync } from "./daily-sync.js";
import { getNetWorth } from "./queries/index.js";
import { getLatestFinancialAnalysis, runFinancialAnalysis } from "./analysis/index.js";
import { getAgentRuntime } from "./ai/runtime.js";
import { getConversationHistory } from "./ai/memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Session map for Plaid Link — single-user local flow for one browser session.
interface LinkSession {
  linkedCount: number;
  complete: () => void;
  completed: boolean;
}

const linkSessions = new Map<string, LinkSession>();
const activeChatControllers = new Map<string, AbortController>();
const agentRuntime = getAgentRuntime();

// Simple rate limiter: track request counts per IP
const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // max requests per window

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

interface LinkResult {
  url: string;
  waitForComplete: () => Promise<number>;
  stop: () => void;
}

interface GuiResult {
  url: string;
  stop: () => void;
}

function ensureSession(sessionId: string): void {
  if (!linkSessions.has(sessionId)) {
    linkSessions.set(sessionId, {
      linkedCount: 0,
      complete: () => {},
      completed: false,
    });
  }
}

export function startLinkServer(): LinkResult {
  const app = express();
  configureLocalApp(app);

  let resolveComplete: () => void;
  const completePromise = new Promise<void>((res) => { resolveComplete = res; });
  const sessionId = randomUUID();
  const session: LinkSession = {
    linkedCount: 0,
    complete: () => {
      if (session.completed) return;
      session.completed = true;
      resolveComplete!();
    },
    completed: false,
  };
  linkSessions.set(sessionId, session);
  registerPlaidRoutes(app);

  // Serve Plaid Link page
  app.get("/link/:session", (req, res) => {
    const sid = req.params.session;
    if (!linkSessions.has(sid)) {
      res.status(404).send("Link session expired or invalid. Please run 'ray link' again.");
      return;
    }
    res.sendFile(resolve(__dirname, "public", "link.html"));
  });

  const server = app.listen(config.port, "127.0.0.1");

  const url = `http://localhost:${config.port}/link/${sessionId}`;

  // Auto-expire after 30 minutes
  const timeout = setTimeout(() => {
    linkSessions.delete(sessionId);
    server.close();
    session.complete();
  }, 30 * 60 * 1000);

  return {
    url,
    waitForComplete: async () => {
      await completePromise;
      return session.linkedCount;
    },
    stop: () => {
      clearTimeout(timeout);
      linkSessions.clear();
      server.close();
    },
  };
}

export function startFinanceGuiServer(): GuiResult {
  const app = express();
  configureLocalApp(app);

  const sessionId = randomUUID();
  ensureSession(sessionId);
  registerPlaidRoutes(app);

  app.get("/", (_req, res) => {
    res.redirect(`/app/${sessionId}`);
  });

  app.get("/app/:session", (req, res) => {
    const sid = req.params.session;
    ensureSession(sid);
    res.sendFile(resolve(__dirname, "public", "app.html"));
  });

  app.get("/chat/:session", (req, res) => {
    const sid = req.params.session;
    ensureSession(sid);
    res.sendFile(resolve(__dirname, "public", "chat.html"));
  });

  app.get("/api/accounts", (_req, res) => {
    try {
      res.json(getAccountsSnapshot());
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to load accounts" });
    }
  });

  app.post("/api/apr-terms", (req, res) => {
    try {
      const accountId = String(req.body?.account_id || "").trim();
      const promoEndDate = String(req.body?.promo_end_date || "").trim();
      const promoApr = req.body?.promo_apr == null ? 0 : Number(req.body.promo_apr);
      const postPromoApr = req.body?.post_promo_apr == null || req.body.post_promo_apr === ""
        ? null
        : Number(req.body.post_promo_apr);
      const enabled = req.body?.enabled == null ? 1 : (req.body.enabled ? 1 : 0);
      const promoStartDate = String(req.body?.promo_start_date || "").trim() || new Date().toISOString().slice(0, 10);

      if (!accountId) {
        res.status(400).json({ error: "account_id is required" });
        return;
      }

      const db = getDb();
      if (!promoEndDate) {
        db.prepare(`DELETE FROM liability_apr_terms WHERE account_id = ?`).run(accountId);
        res.json({ success: true, snapshot: getAccountsSnapshot() });
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(promoEndDate)) {
        res.status(400).json({ error: "promo_end_date must be YYYY-MM-DD" });
        return;
      }

      const hasAccount = db.prepare(`
        SELECT account_id FROM accounts WHERE account_id = ? AND type IN ('credit', 'loan')
      `).get(accountId) as { account_id: string } | undefined;
      if (!hasAccount) {
        res.status(404).json({ error: "Eligible account not found" });
        return;
      }

      db.prepare(`
        INSERT INTO liability_apr_terms
          (account_id, promo_apr, promo_start_date, promo_end_date, post_promo_apr, enabled, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'user', datetime('now'))
        ON CONFLICT(account_id) DO UPDATE SET
          promo_apr = excluded.promo_apr,
          promo_start_date = excluded.promo_start_date,
          promo_end_date = excluded.promo_end_date,
          post_promo_apr = excluded.post_promo_apr,
          enabled = excluded.enabled,
          source = excluded.source,
          updated_at = datetime('now')
      `).run(accountId, Number.isFinite(promoApr) ? promoApr : 0, promoStartDate, promoEndDate, postPromoApr, enabled);

      res.json({ success: true, snapshot: getAccountsSnapshot() });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to save APR promo terms" });
    }
  });

  app.post("/api/sync", async (_req, res) => {
    try {
      const db = getDb();
      const result = await runDailySync(db);
      const analysis = runFinancialAnalysis(db);
      res.json({ success: true, result, snapshot: getAccountsSnapshot(), analysis });
    } catch (error: any) {
      console.error("GUI sync error:", error.message);
      res.status(500).json({ error: error.message || "Sync failed" });
    }
  });

  app.get("/api/analysis", (_req, res) => {
    try {
      const db = getDb();
      const analysis = getLatestFinancialAnalysis(db) ?? runFinancialAnalysis(db);
      res.json({ analysis });
    } catch (error: any) {
      console.error("GUI analysis load error:", error.message);
      res.status(500).json({ error: error.message || "Analysis failed" });
    }
  });

  app.post("/api/analyze", (_req, res) => {
    try {
      const db = getDb();
      const analysis = runFinancialAnalysis(db);
      res.json({ success: true, analysis });
    } catch (error: any) {
      console.error("GUI analysis error:", error.message);
      res.status(500).json({ error: error.message || "Analysis failed" });
    }
  });

  app.get("/api/chat-history", (_req, res) => {
    try {
      const db = getDb();
      const history = getConversationHistory(db, 12).map((message: any) => ({
        role: message.role,
        content: message.content,
        created_at: message.created_at,
      }));
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to load chat history" });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const message = String(req.body?.message || "").trim();
      if (!message) {
        res.status(400).json({ error: "Message is required" });
        return;
      }
      if (message.length > 4000) {
        res.status(400).json({ error: "Message is too long" });
        return;
      }

      const db = getDb();
      const progress: { phase: string; toolName?: string; toolCount: number; elapsedMs: number }[] = [];
      const reply = await agentRuntime.chat({
        db,
        message,
        onProgress: event => progress.push(event),
        surface: "web",
      });
      res.json({ reply, progress });
    } catch (error: any) {
      console.error("GUI chat error:", error.message);
      res.status(500).json({ error: error.message || "Chat failed" });
    }
  });

  app.post("/api/chat-stream", async (req, res) => {
    const requestId = String(req.body?.request_id || randomUUID());
    const message = String(req.body?.message || "").trim();
    if (!message) {
      res.status(400).json({ error: "Message is required" });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: "Message is too long" });
      return;
    }

    const abortController = new AbortController();
    activeChatControllers.set(requestId, abortController);
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeEvent = (event: Record<string, any>) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      const db = getDb();
      writeEvent({ type: "start", request_id: requestId });

      const reply = await agentRuntime.chat({
        db,
        message,
        signal: abortController.signal,
        surface: "web",
        onProgress: progress => writeEvent({ type: "progress", request_id: requestId, progress }),
      });

      // Stream in chunks for a smoother chat UI update.
      const chunks = chunkText(reply, 18);
      for (const chunk of chunks) {
        if (abortController.signal.aborted) break;
        writeEvent({ type: "delta", request_id: requestId, text: chunk });
      }

      writeEvent({ type: "final", request_id: requestId, reply });
      res.end();
    } catch (error: any) {
      if (abortController.signal.aborted) {
        writeEvent({ type: "aborted", request_id: requestId });
      } else {
        console.error("GUI chat stream error:", error.message);
        writeEvent({ type: "error", request_id: requestId, message: error.message || "Chat failed" });
      }
      res.end();
    } finally {
      activeChatControllers.delete(requestId);
    }
  });

  app.post("/api/chat-cancel", (req, res) => {
    const requestId = String(req.body?.request_id || "");
    if (!requestId) {
      res.status(400).json({ error: "request_id is required" });
      return;
    }
    const controller = activeChatControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeChatControllers.delete(requestId);
      res.json({ success: true, cancelled: true });
      return;
    }
    res.json({ success: true, cancelled: false });
  });

  app.get("/api/chat-export", (req, res) => {
    try {
      const format = String(req.query.format || "json").toLowerCase();
      const db = getDb();
      const history = getConversationHistory(db, 1000).map((message: any) => ({
        role: message.role,
        content: message.content,
        created_at: message.created_at,
      }));
      const exportedAt = new Date().toISOString();

      if (format === "md" || format === "markdown") {
        const markdown = [
          "# Sensei-Fi Chat Export",
          "",
          `Exported: ${exportedAt}`,
          "",
          ...history.flatMap((message: any) => [
            `## ${String(message.role || "assistant").toUpperCase()} - ${message.created_at || ""}`,
            "",
            String(message.content || ""),
            "",
          ]),
        ].join("\n");
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"senseifi-chat-export.md\"");
        res.send(markdown);
        return;
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"senseifi-chat-export.json\"");
      res.send(JSON.stringify({ exported_at: exportedAt, history }, null, 2));
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to export chat" });
    }
  });

  const server = app.listen(config.port, "127.0.0.1");
  const url = `http://localhost:${config.port}/app/${sessionId}`;

  return {
    url,
    stop: () => {
      linkSessions.delete(sessionId);
      server.close();
    },
  };
}

function configureLocalApp(app: express.Express): void {
  app.use(express.json());
  app.use((req, res, next) => {
    const origin = req.headers.origin || req.headers.referer || "";
    const ip = req.ip || req.socket.remoteAddress || "";
    if (req.path.startsWith("/api/")) {
      if (origin && !origin.startsWith(`http://localhost:${config.port}`) && !origin.startsWith(`http://127.0.0.1:${config.port}`)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (isRateLimited(ip)) {
        res.status(429).json({ error: "Too many requests" });
        return;
      }
    }
    next();
  });
  app.use(express.static(resolve(__dirname, "public")));
}

function registerPlaidRoutes(app: express.Express): void {
  app.post("/api/link-token", async (req, res) => {
    try {
      const { session_id } = req.body;
      const session = linkSessions.get(session_id);
      if (!session) {
        res.status(404).json({ error: "Invalid or expired session" });
        return;
      }
      const linkToken = await createLinkToken();
      res.json({ link_token: linkToken });
    } catch (error: any) {
      console.error("Link token error:", error.message);
      const plaidStatus = error?.response?.status;
      if (plaidStatus === 400 || plaidStatus === 401 || plaidStatus === 403) {
        res.status(500).json({
          error: "Plaid credentials error. Make sure you're using production keys.",
        });
      } else {
        res.status(500).json({ error: "Failed to create link token: " + (error.message || "unknown error") });
      }
    }
  });

  app.post("/api/exchange", async (req, res) => {
    try {
      const { session_id, institution_name } = req.body;
      const session = linkSessions.get(session_id);
      if (!session) {
        res.status(404).json({ error: "Invalid or expired session" });
        return;
      }

      const result = await exchangeAndSyncInstitution(req.body);
      session.linkedCount++;
      res.json({
        success: true,
        institution_name,
        institution_logo: result.institutionLogo,
        linked_count: session.linkedCount,
        snapshot: getAccountsSnapshot(),
      });
    } catch (error: any) {
      console.error("Token exchange error:", error.message);
      res.status(500).json({ error: "Failed to link account" });
    }
  });

  app.post("/api/update-link-token", async (req, res) => {
    try {
      const { session_id, item_id } = req.body;
      const session = linkSessions.get(session_id);
      if (!session) {
        res.status(404).json({ error: "Invalid or expired session" });
        return;
      }
      if (!item_id) {
        res.status(400).json({ error: "Missing item_id" });
        return;
      }

      const accessToken = getAccessTokenForItem(item_id);
      const linkToken = await createAccountSelectionUpdateLinkToken(accessToken);
      res.json({ link_token: linkToken });
    } catch (error: any) {
      console.error("Update link token error:", error.message);
      res.status(500).json({ error: error.message || "Failed to create update link token" });
    }
  });

  app.post("/api/update-complete", async (req, res) => {
    try {
      const { session_id, item_id } = req.body;
      const session = linkSessions.get(session_id);
      if (!session) {
        res.status(404).json({ error: "Invalid or expired session" });
        return;
      }
      if (!item_id) {
        res.status(400).json({ error: "Missing item_id" });
        return;
      }

      const summary = await syncExistingInstitution(item_id);
      res.json({ success: true, summary, snapshot: getAccountsSnapshot() });
    } catch (error: any) {
      console.error("Update completion error:", error.message);
      res.status(500).json({ error: error.message || "Failed to update account selection" });
    }
  });

  app.post("/api/finish", (req, res) => {
    const { session_id } = req.body;
    const session = linkSessions.get(session_id);
    if (!session) {
      res.status(404).json({ error: "Invalid or expired session" });
      return;
    }

    res.json({ success: true, linked_count: session.linkedCount });
    session.complete();
  });
}

async function exchangeAndSyncInstitution(body: any): Promise<{ institutionLogo: string | null }> {
  const { public_token, institution_name } = body;
  const db = getDb();
  const { accessToken, itemId } = await exchangeToken(public_token);

  if (!config.plaidTokenSecret) {
    throw new Error("Plaid token secret not configured. Run setup first.");
  }
  const encryptedToken = encryptPlaidToken(accessToken, config.plaidTokenSecret);
  const itemResp = await plaidClient.itemGet({ access_token: accessToken });
  const products: string[] = (itemResp.data.item.products || []) as string[];

  const institutionId = body.institution_id;
  if (institutionId) {
    const existing = db.prepare(
      `SELECT item_id FROM institutions WHERE name = ? AND item_id != ?`
    ).all(institution_name, itemId) as { item_id: string }[];
    for (const old of existing) {
      const oldAccounts = db.prepare(`SELECT account_id FROM accounts WHERE item_id = ?`).all(old.item_id) as { account_id: string }[];
      for (const acct of oldAccounts) {
        db.prepare(`DELETE FROM transactions WHERE account_id = ?`).run(acct.account_id);
        db.prepare(`DELETE FROM holdings WHERE account_id = ?`).run(acct.account_id);
        db.prepare(`DELETE FROM investment_transactions WHERE account_id = ?`).run(acct.account_id);
        db.prepare(`DELETE FROM liabilities WHERE account_id = ?`).run(acct.account_id);
        db.prepare(`DELETE FROM recurring WHERE account_id = ?`).run(acct.account_id);
      }
      db.prepare(`DELETE FROM accounts WHERE item_id = ?`).run(old.item_id);
      db.prepare(`DELETE FROM institutions WHERE item_id = ?`).run(old.item_id);
    }
  }

  db.prepare(
    `INSERT INTO institutions (item_id, access_token, name, products)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET access_token = excluded.access_token, products = excluded.products`
  ).run(itemId, encryptedToken, institution_name || "Account", JSON.stringify(products));

  const runSync = async () => {
    await syncBalances(db, accessToken);
    if (products.includes("transactions")) {
      await syncTransactions(db, itemId, accessToken, null);
    }
    if (products.includes("investments")) {
      try { await syncInvestments(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
      try { await syncInvestmentTransactions(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
    }
    if (products.includes("liabilities")) {
      try { await syncLiabilities(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
    }
    if (products.includes("transactions")) {
      try { await syncRecurring(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
    }
  };

  try {
    await runSync();
  } catch (syncErr: any) {
    console.error("Initial sync error, will retry in 30s:", syncErr.message);
    setTimeout(async () => {
      try {
        await runSync();
        console.log("Retry sync succeeded for", institution_name);
      } catch (retryErr: any) {
        console.error("Retry sync also failed:", retryErr.message);
        setTimeout(async () => {
          try {
            await runSync();
            console.log("Final retry sync succeeded for", institution_name);
          } catch (finalErr: any) {
            console.error("Final sync retry failed:", finalErr.message);
          }
        }, 120_000);
      }
    }, 30_000);
  }

  let institutionLogo: string | null = null;
  if (body.institution_id) {
    try {
      const { data } = await plaidClient.institutionsGetById({
        institution_id: body.institution_id,
        country_codes: getCountryCodes(),
        options: { include_optional_metadata: true },
      });
      institutionLogo = data.institution.logo || null;
      const primaryColor = data.institution.primary_color || null;
      db.prepare(`UPDATE institutions SET logo = ?, primary_color = ? WHERE item_id = ?`)
        .run(institutionLogo, primaryColor, itemId);
    } catch {}
  }

  return { institutionLogo };
}

async function syncExistingInstitution(itemId: string): Promise<{ products: string[]; accountCount: number }> {
  const db = getDb();
  const accessToken = getAccessTokenForItem(itemId);
  const products = await refreshProducts(db, itemId, accessToken);
  const accountCount = await syncBalances(db, accessToken);

  if (products.includes("transactions")) {
    await syncTransactions(db, itemId, accessToken, null);
  }
  if (products.includes("investments")) {
    try { await syncInvestments(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
    try { await syncInvestmentTransactions(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
  }
  if (products.includes("liabilities")) {
    try { await syncLiabilities(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
  }
  if (products.includes("transactions")) {
    try { await syncRecurring(db, accessToken); } catch (e) { if (!isProductNotSupported(e)) throw e; }
  }

  return { products, accountCount };
}

function getAccessTokenForItem(itemId: string): string {
  const db = getDb();
  const row = db.prepare(`
    SELECT access_token FROM institutions
    WHERE item_id = ? AND access_token != 'manual'
  `).get(itemId) as { access_token: string } | undefined;
  if (!row) throw new Error("Institution was not found.");
  if (!config.plaidTokenSecret) throw new Error("Plaid token secret not configured. Run setup first.");
  return decryptPlaidToken(row.access_token, config.plaidTokenSecret);
}

function getAccountsSnapshot() {
  const db = getDb();
  const netWorth = getNetWorth(db);
  const today = new Date().toISOString().slice(0, 10);
  const institutions = db.prepare(`
    SELECT item_id, name, products, logo, primary_color, created_at
    FROM institutions
    WHERE item_id != 'manual-assets'
    ORDER BY created_at
  `).all() as {
    item_id: string;
    name: string;
    products: string;
    logo: string | null;
    primary_color: string | null;
    created_at: string;
  }[];

  const accounts = db.prepare(`
    SELECT account_id, item_id, name, official_name, type, subtype, mask,
           current_balance, available_balance, currency, updated_at,
           l.interest_rate as liability_interest_rate,
           t.promo_apr, t.promo_start_date, t.promo_end_date, t.post_promo_apr, t.enabled as promo_enabled
    FROM accounts
    LEFT JOIN liabilities l ON l.account_id = accounts.account_id
    LEFT JOIN liability_apr_terms t ON t.account_id = accounts.account_id
    WHERE hidden = 0
    ORDER BY type, current_balance DESC
  `).all() as any[];

  const txCount = db.prepare(`SELECT COUNT(*) as count FROM transactions`).get() as { count: number };
  const lastTransaction = db.prepare(`SELECT MAX(date) as date FROM transactions`).get() as { date: string | null };

  return {
    netWorth,
    transactionCount: txCount.count,
    lastTransactionDate: lastTransaction.date,
    institutions: institutions.map(inst => ({
      ...inst,
      products: safeJsonArray(inst.products),
      accounts: accounts
        .filter(account => account.item_id === inst.item_id)
        .map(account => ({
          ...account,
          effective_apr: computeEffectiveApr(account, today),
          apr_label: formatAprLabel(account, today),
        })),
    })),
    manualAccounts: accounts
      .filter(account => account.item_id === "manual-assets")
      .map(account => ({
        ...account,
        effective_apr: computeEffectiveApr(account, today),
        apr_label: formatAprLabel(account, today),
      })),
  };
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function chunkText(text: string, wordsPerChunk = 18): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const slice = words.slice(i, i + wordsPerChunk).join(" ");
    chunks.push(slice + (i + wordsPerChunk < words.length ? " " : ""));
  }
  return chunks;
}

function computeEffectiveApr(account: any, today: string): number | null {
  const promoEnabled = Number(account.promo_enabled || 0) === 1;
  const promoEnd = account.promo_end_date ? String(account.promo_end_date) : null;
  const promoStart = account.promo_start_date ? String(account.promo_start_date) : "1900-01-01";
  if (promoEnabled && promoEnd && today >= promoStart && today <= promoEnd) {
    return Number.isFinite(Number(account.promo_apr)) ? Number(account.promo_apr) : 0;
  }
  if (Number.isFinite(Number(account.post_promo_apr)) && Number(account.post_promo_apr) > 0) {
    return Number(account.post_promo_apr);
  }
  if (Number.isFinite(Number(account.liability_interest_rate)) && Number(account.liability_interest_rate) > 0) {
    return Number(account.liability_interest_rate);
  }
  if (account.type === "credit") return 22;
  if (String(account.subtype || "").toLowerCase().includes("student")) return 5.5;
  if (String(account.subtype || "").toLowerCase().includes("mortgage")) return 6.5;
  if (account.type === "loan") return 8.5;
  return null;
}

function formatAprLabel(account: any, today: string): string {
  const promoEnabled = Number(account.promo_enabled || 0) === 1;
  const promoEnd = account.promo_end_date ? String(account.promo_end_date) : null;
  const promoStart = account.promo_start_date ? String(account.promo_start_date) : "1900-01-01";
  if (promoEnabled && promoEnd && today >= promoStart && today <= promoEnd) {
    return `Promo APR ${Number(account.promo_apr || 0).toFixed(2)}% until ${promoEnd}`;
  }
  const effective = computeEffectiveApr(account, today);
  if (effective == null) return "APR defaulted";
  if (promoEnd && today > promoEnd && Number.isFinite(Number(account.post_promo_apr)) && Number(account.post_promo_apr) > 0) {
    return `Post-promo APR ${Number(account.post_promo_apr).toFixed(2)}%`;
  }
  return `APR ${Number(effective).toFixed(2)}%`;
}
