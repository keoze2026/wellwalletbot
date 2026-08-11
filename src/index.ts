import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InputFile, type Context } from "grammy";
import nodemailer from "nodemailer";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/** Parses a comma-separated list of positive integer Telegram user IDs. */
function parseIds(raw: string): Set<number> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

/**
 * Wallet ownership type sent to POST /wallets. Determines where deposits land:
 *   - "user"       — private, per-user wallet
 *   - "accounting" — exchange / aggregation wallet
 */
function walletTypeFrom(raw: string): "user" | "accounting" {
  if (raw !== "user" && raw !== "accounting") {
    throw new Error(`WALLET_TYPE must be "user" or "accounting", got "${raw}"`);
  }
  return raw;
}

/**
 * Which transaction directions trigger an email alert:
 *   "in" = deposit, "out" = withdrawal. Defaults to both.
 */
function parseDirections(raw: string): Set<"in" | "out"> {
  const set = new Set<"in" | "out">();
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (part === "in" || part === "out") set.add(part);
  }
  if (set.size === 0) {
    set.add("in");
    set.add("out");
  }
  return set;
}

/**
 * Wallet-pruning settings. The provider caps an account at 500 wallets, and
 * POST /wallets answers 404 once that cap is hit — so the oldest wallets are
 * recycled whenever the count passes `threshold`.
 */
function pruneConfigFrom() {
  const num = (name: string, fallback: number): number => {
    const value = Number(optional(name, String(fallback)));
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number, got "${process.env[name]}"`);
    }
    return value;
  };
  return {
    enabled: optional("WALLET_PRUNE_ENABLED", "true") === "true",
    // Log what would be deleted without deleting anything.
    dryRun: optional("WALLET_PRUNE_DRY_RUN", "false") === "true",
    threshold: num("WALLET_PRUNE_THRESHOLD", 350),
    // How many of the oldest wallets to consider per sweep. Only the empty ones
    // inside this window are deleted, so a sweep frees between 0 and `window`.
    window: num("WALLET_PRUNE_WINDOW", 200),
    intervalHours: num("WALLET_PRUNE_INTERVAL_HOURS", 6),
    // Never delete a wallet younger than this — a user may still be about to
    // pay into an address /topup handed them.
    minAgeHours: num("WALLET_PRUNE_MIN_AGE_HOURS", 24),
  };
}

/**
 * Email/SMTP settings for transaction notifications. Returns null (email
 * disabled) unless at least SMTP_HOST and MAIL_TO are provided.
 */
function mailConfigFrom() {
  const host = optional("SMTP_HOST", "");
  const to = optional("MAIL_TO", "");
  if (!host || !to) return null;
  const user = optional("SMTP_USER", "");
  return {
    host,
    port: Number(optional("SMTP_PORT", "587")),
    secure: optional("SMTP_SECURE", "false") === "true",
    user,
    pass: optional("SMTP_PASS", ""),
    from: optional("MAIL_FROM", user),
    to,
  };
}

const config = {
  botToken: required("BOT_TOKEN"),
  logLevel: optional("LOG_LEVEL", "info"),
  adminIds: parseIds(optional("ADMIN_IDS", "")),
  walletApi: {
    baseUrl: required("WALLET_API_BASE_URL"),
    token: required("WALLET_API_TOKEN"),
    walletType: walletTypeFrom(optional("WALLET_TYPE", "accounting")),
  },
  webhook: {
    port: Number(optional("WEBHOOK_PORT", "8080")),
    // The provider POSTs transaction callbacks here. Put a hard-to-guess secret
    // in the path (e.g. /webhook/9f3a…) — exact-path match is the auth.
    path: optional("WEBHOOK_PATH", "/webhook"),
  },
  notifyDirections: parseDirections(optional("NOTIFY_DIRECTIONS", "in,out")),
  mail: mailConfigFrom(),
  prune: pruneConfigFrom(),
} as const;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type Level = "debug" | "info" | "warn" | "error";
const levelOrder: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levelOrder[(config.logLevel as Level)] ?? levelOrder.info;

function log(level: Level, message: string, ...args: unknown[]): void {
  if (levelOrder[level] < threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

const logger = {
  debug: (m: string, ...a: unknown[]) => log("debug", m, ...a),
  info: (m: string, ...a: unknown[]) => log("info", m, ...a),
  warn: (m: string, ...a: unknown[]) => log("warn", m, ...a),
  error: (m: string, ...a: unknown[]) => log("error", m, ...a),
};

// ---------------------------------------------------------------------------
// Wallet API client (provider-agnostic)
// ---------------------------------------------------------------------------

interface WalletData {
  address: string;
  qr: string;
  network: string;
  network_name: string;
  name: string;
  user_id: string;
}

/**
 * One entry of GET /wallets -> data.wallets. Note the API returns **no**
 * creation timestamp, so wallet age has to come from the `name` we set.
 */
interface WalletListEntry {
  address: string;
  name?: string;
  type?: string;
  network?: string;
  status?: string;
  /** Token ticker -> { available }. Only the list endpoint returns balances. */
  balances?: Record<string, { available?: number | string | null } | null> | null;
}

interface WalletListData {
  user_id?: string;
  count?: number;
  wallets?: WalletListEntry[];
}

/**
 * Response envelope. The docs specify snake_case (error_message/error_code) but
 * the live API answers in camelCase — accept both, or real error text is lost.
 */
interface ApiEnvelope<T> {
  code?: string;
  error_code?: string;
  error_message?: string;
  errorCode?: string;
  errorMessage?: string;
  data?: T;
}

const envelopeError = (e: ApiEnvelope<unknown>) => ({
  message: e.errorMessage ?? e.error_message,
  code: e.errorCode ?? e.error_code,
});

/**
 * One wallet-API call. Every endpoint shares the same envelope and `token`
 * header auth, so transport and error handling live here and callers get
 * `data` back.
 */
async function walletApiRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const url = `${config.walletApi.baseUrl}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        token: config.walletApi.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    logger.error(`Wallet API ${method} ${path} failed (network error):`, err);
    throw new Error("Failed to reach the wallet provider");
  }

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }

  if (!res.ok) {
    // A non-object body (a bare "403" from the load balancer) means the request
    // was blocked at the network edge — an IP allowlist / WAF rule, not an
    // app-level error.
    if (typeof parsed !== "object" || parsed === null) {
      logger.error(
        `Wallet API edge-blocked (${res.status}) — source IP likely not allowlisted by the provider. Body: ${String(parsed)}`,
      );
      throw new Error(`Wallet provider blocked the request (${res.status})`);
    }
    // A 404 here is usually the 500-wallet account cap rather than a missing
    // route. Log the raw payload when it isn't the documented envelope, or the
    // real reason stays invisible.
    const { message, code } = envelopeError(parsed as ApiEnvelope<unknown>);
    const detail = message ?? `(undocumented body: ${raw.slice(0, 300)})`;
    logger.error(`Wallet API ${method} ${url} -> ${res.status} ${code ?? ""}: ${detail}`);
    throw new Error(message || `Wallet provider returned ${res.status}`);
  }

  return (parsed as ApiEnvelope<T> | undefined)?.data;
}

/**
 * POST /wallets — creates a brand-new wallet address. Starts failing once the
 * account holds 500 wallets; see pruneOldWallets().
 */
async function createTrc20Wallet(name: string): Promise<WalletData> {
  const data = await walletApiRequest<WalletData>("POST", "/wallets", {
    name,
    network: "trx",
    type: config.walletApi.walletType,
  });
  if (!data?.address) {
    logger.error("Wallet API response missing address:", data);
    throw new Error("Wallet provider returned no address");
  }
  return data;
}

/** GET /wallets — one page of the account's wallets. */
async function listWalletPage(offset: number, limit: number): Promise<WalletListData> {
  const data = await walletApiRequest<WalletListData>(
    "GET",
    `/wallets?offset=${offset}&limit=${limit}`,
  );
  return data ?? {};
}

/** GET /wallets?address= — re-reads a single wallet, for the pre-delete check. */
async function fetchWallet(address: string): Promise<WalletListEntry | undefined> {
  const data = await walletApiRequest<WalletListData>(
    "GET",
    `/wallets?address=${encodeURIComponent(address)}`,
  );
  return data?.wallets?.find((w) => w.address === address);
}

/** DELETE /wallets — the address goes in the JSON body, not the path. */
async function deleteWallet(address: string): Promise<void> {
  await walletApiRequest<{ result?: string }>("DELETE", "/wallets", { address });
}

// ---------------------------------------------------------------------------
// Wallet pruning (the provider caps the account at 500 wallets)
// ---------------------------------------------------------------------------

const PRUNE_PAGE_SIZE = 200;
const PRUNE_MAX_PAGES = 25; // safety stop at 5,000 wallets, far above the cap
const PRUNE_DELETE_DELAY_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Walks GET /wallets until a short page says we have them all. */
async function listAllWallets(): Promise<WalletListEntry[]> {
  const all: WalletListEntry[] = [];
  for (let page = 0; page < PRUNE_MAX_PAGES; page++) {
    const data = await listWalletPage(page * PRUNE_PAGE_SIZE, PRUNE_PAGE_SIZE);
    const batch = data.wallets ?? [];
    all.push(...batch);
    if (batch.length < PRUNE_PAGE_SIZE) return all;
  }
  logger.warn(`Wallet list hit the ${PRUNE_MAX_PAGES}-page safety stop at ${all.length} wallets.`);
  return all;
}

/**
 * Creation time (epoch ms) recovered from the wallet name. The API returns no
 * timestamp, but /topup names every wallet `tg-<telegramId>-<Date.now()>`, so
 * the name is both the age signal and proof this bot created it. Anything else
 * — manually created or aggregation wallets — yields null and is never touched.
 */
function createdAtFromName(name?: string): number | null {
  const parts = (name ?? "").split("-");
  if (parts.length < 3 || parts[0] !== "tg") return null;
  const ms = Number(parts[parts.length - 1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Balance state of a wallet, as three states rather than a boolean.
 *
 * Missing or unparseable balance data must NOT read as "empty": deleting is
 * irreversible, so absent evidence of funds is not evidence of absence. Only an
 * explicit zero on every token authorises deletion; anything else is "unknown"
 * and the wallet is left alone.
 */
function fundsState(wallet: WalletListEntry): "empty" | "funded" | "unknown" {
  const balances = wallet.balances;
  if (!balances || typeof balances !== "object") return "unknown";
  const entries = Object.values(balances);
  if (entries.length === 0) return "unknown";

  for (const balance of entries) {
    const raw = balance?.available;
    // Number(null) and Number("") are both 0, so converting first would read
    // "no data" as a confirmed zero balance and authorise deleting the wallet.
    // Reject anything that isn't an actual figure before converting.
    if (raw === null || raw === undefined) return "unknown";
    if (typeof raw === "string" && raw.trim() === "") return "unknown";
    const available = Number(raw);
    if (!Number.isFinite(available) || available < 0) return "unknown";
    if (available > 0) return "funded";
  }
  return "empty"; // every token reported an explicit zero
}

let isPruning = false;

/**
 * Frees headroom under the provider's 500-wallet cap. Once the account exceeds
 * WALLET_PRUNE_THRESHOLD, this looks at the oldest WALLET_PRUNE_WINDOW wallets
 * and deletes only the ones holding a zero balance.
 *
 * Deletion is irreversible — the provider warns that funds sent to a deleted
 * address are inaccessible without their support team. So a wallet is only ever
 * a candidate when all three hold: this bot created it (name pattern), every
 * token balance is zero, and it is older than WALLET_PRUNE_MIN_AGE_HOURS.
 */
async function pruneOldWallets(trigger: string): Promise<void> {
  const cfg = config.prune;
  if (!cfg.enabled || isPruning) return;
  isPruning = true;
  try {
    const wallets = await listAllWallets();
    const total = wallets.length;
    if (total <= cfg.threshold) {
      logger.info(
        `Wallet prune (${trigger}): ${total} wallets, at or below the ${cfg.threshold} threshold — nothing to do.`,
      );
      return;
    }

    // Only bot-created wallets have a recoverable age (the API returns no
    // timestamp), so they alone define the "oldest" ordering. Anything else —
    // manually created or aggregation wallets — is never a candidate.
    const aged: Array<{ entry: WalletListEntry; createdAt: number }> = [];
    let foreign = 0;
    for (const entry of wallets) {
      const createdAt = createdAtFromName(entry.name);
      if (createdAt === null) foreign++;
      else aged.push({ entry, createdAt });
    }
    aged.sort((a, b) => a.createdAt - b.createdAt); // oldest first

    // Look at the oldest `window` wallets and take only the empty ones.
    const cutoff = Date.now() - cfg.minAgeHours * 60 * 60 * 1000;
    const oldest = aged.slice(0, cfg.window);
    const doomed: Array<{ entry: WalletListEntry; createdAt: number }> = [];
    let funded = 0;
    let tooNew = 0;
    let unknown = 0;
    for (const candidate of oldest) {
      const state = fundsState(candidate.entry);
      if (state === "funded") funded++;
      else if (state === "unknown") unknown++;
      else if (candidate.createdAt > cutoff) tooNew++;
      else doomed.push(candidate);
    }

    logger.info(
      `Wallet prune (${trigger}): ${total} wallets exceeds ${cfg.threshold} — scanning the oldest ` +
        `${oldest.length} of ${aged.length} bot-created, deleting ${doomed.length} with a zero balance ` +
        `(kept back: ${funded} funded, ${unknown} balance unknown, ${tooNew} younger than ` +
        `${cfg.minAgeHours}h, ${foreign} not bot-created).`,
    );
    if (unknown > 0) {
      logger.warn(
        `Wallet prune: ${unknown} wallets report no usable balance figure and were left alone. If this ` +
          `is every wallet, the list endpoint is not returning balances — do not disable this guard.`,
      );
    }
    if (total - doomed.length > cfg.threshold) {
      logger.warn(
        `Wallet prune: ${total - doomed.length} wallets would remain, still above ${cfg.threshold} — ` +
          `raise WALLET_PRUNE_WINDOW or sweep funded wallets to free more.`,
      );
    }

    let deleted = 0;
    let raced = 0;
    for (const { entry, createdAt } of doomed) {
      const age = `${Math.round((Date.now() - createdAt) / (60 * 60 * 1000))}h old`;
      if (cfg.dryRun) {
        logger.info(`Wallet prune [dry run]: would delete ${entry.address} (${entry.name}, ${age})`);
        continue;
      }

      // Re-read the balance immediately before deleting. The listing above can
      // be a minute old by the time we reach the tail of the queue, and a
      // deposit landing in that gap would otherwise be deleted with the wallet.
      let state: ReturnType<typeof fundsState>;
      try {
        const fresh = await fetchWallet(entry.address);
        state = fresh ? fundsState(fresh) : "unknown";
      } catch (err) {
        logger.error(`Wallet prune: balance re-check failed for ${entry.address}, skipping:`, err);
        raced++;
        continue;
      }
      if (state !== "empty") {
        logger.warn(
          `Wallet prune: skipping ${entry.address} — balance became ${state} since the listing.`,
        );
        raced++;
        continue;
      }

      try {
        await deleteWallet(entry.address);
        deleted++;
        logger.info(`Wallet prune: deleted ${entry.address} (${entry.name}, ${age})`);
      } catch (err) {
        logger.error(`Wallet prune: failed to delete ${entry.address}:`, err);
      }
      await sleep(PRUNE_DELETE_DELAY_MS);
    }
    if (raced > 0) {
      logger.warn(`Wallet prune: ${raced} wallets skipped at delete time by the balance re-check.`);
    }
    if (!cfg.dryRun) {
      logger.info(`Wallet prune (${trigger}): deleted ${deleted}, ${total - deleted} wallets remain.`);
    }
  } catch (err) {
    logger.error(`Wallet prune (${trigger}) failed:`, err);
  } finally {
    isPruning = false;
  }
}

/** Prunes at startup, then every WALLET_PRUNE_INTERVAL_HOURS. */
function startWalletPruneSchedule(): void {
  const cfg = config.prune;
  if (!cfg.enabled) {
    logger.warn("Wallet pruning disabled (set WALLET_PRUNE_ENABLED=true to enable).");
    return;
  }
  logger.info(
    `Wallet pruning enabled: above ${cfg.threshold} wallets, delete empty ones among the oldest ` +
      `${cfg.window}; every ${cfg.intervalHours}h, min age ${cfg.minAgeHours}h` +
      `${cfg.dryRun ? " [DRY RUN — nothing will be deleted]" : ""}.`,
  );
  void pruneOldWallets("startup");
  setInterval(() => void pruneOldWallets("scheduled"), cfg.intervalHours * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const WELCOME_MESSAGE = [
  "<b>Welcome${name}</b>",
  "",
  "I generate crypto deposit addresses — no login required. Accepted method: <b>USDT (TRC-20)</b>.",
  "",
  "<b>How to use</b>",
  "<code>/topup</code>",
  "",
  "A fresh TRC-20 deposit address is generated every time you run the command.",
  "",
  "Type /help any time to see this again.",
].join("\n");

function renderWelcome(firstName?: string): string {
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  return WELCOME_MESSAGE.replace("${name}", name);
}

function buildAddressMessage(wallet: WalletData): string {
  const network = wallet.network_name || "TRC-20 (TRON)";
  return [
    "<b>New deposit address!</b>",
    "",
    `<b>Network:</b> ${escapeHtml(network)}`,
    `<b>Address:</b> <code>${escapeHtml(wallet.address)}</code>`,
    "",
    "⚠️ Send only <b>USDT-TRC20</b> to this address.",
    "A new address is generated each time you run /topup.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

// The bot is always on once started. An admin can pause it with /stop and
// resume it with /start — pausing only gates request handling, it does NOT
// stop the process.
let isPaused = false;
const isAdmin = (userId?: number): boolean => !!userId && config.adminIds.has(userId);
const PAUSED_MESSAGE = "The bot is currently paused. Please try again later.";

// ---------------------------------------------------------------------------
// Commands & handlers
// ---------------------------------------------------------------------------

const commandList = [
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show available commands" },
  { command: "topup", description: "Generate a new TRC20 deposit address" },
];

async function startCommand(ctx: Context): Promise<void> {
  if (isPaused) {
    if (isAdmin(ctx.from?.id)) {
      isPaused = false;
      logger.info(`Bot resumed by admin ${ctx.from?.id}`);
      await ctx.reply("✅ Bot resumed. It is accepting requests again.");
      return;
    }
    await ctx.reply(PAUSED_MESSAGE);
    return;
  }
  await ctx.reply(renderWelcome(ctx.from?.first_name), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function stopCommand(ctx: Context): Promise<void> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is restricted to bot admins.");
    return;
  }
  if (isPaused) {
    await ctx.reply("The bot is already paused. Send /start to resume.");
    return;
  }
  isPaused = true;
  logger.info(`Bot paused by admin ${ctx.from?.id}`);
  await ctx.reply("⏸️ Bot paused. Send /start to resume.");
}

async function helpCommand(ctx: Context): Promise<void> {
  await ctx.reply(renderWelcome(ctx.from?.first_name), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** Sends the QR returned by the API (http URL or base64 data URI), best-effort. */
async function trySendQr(ctx: Context, qr: string, address: string): Promise<void> {
  try {
    if (qr.startsWith("http://") || qr.startsWith("https://")) {
      await ctx.replyWithPhoto(qr, { caption: `TRC20: ${address}` });
    } else if (qr.startsWith("data:image")) {
      const buffer = Buffer.from(qr.slice(qr.indexOf(",") + 1), "base64");
      await ctx.replyWithPhoto(new InputFile(buffer, "qr.png"), {
        caption: `TRC20: ${address}`,
      });
    }
  } catch (err) {
    logger.warn("Failed to send QR image:", err);
  }
}

/**
 * /topup — generates a fresh TRC20 (USDT-TRON) deposit address every time it
 * is run. A unique `name` is sent per call so the API returns a new address.
 */
async function topupCommand(ctx: Context): Promise<void> {
  if (isPaused) {
    await ctx.reply(PAUSED_MESSAGE);
    return;
  }
  await ctx.replyWithChatAction("typing");
  try {
    const name = `tg-${ctx.from?.id ?? "unknown"}-${Date.now()}`;
    const wallet = await createTrc20Wallet(name);

    await ctx.reply(buildAddressMessage(wallet), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    if (wallet.qr) await trySendQr(ctx, wallet.qr, wallet.address);
  } catch (err) {
    logger.error("/topup failed:", err);
    // Hitting the 500-wallet cap surfaces exactly here, so make room now rather
    // than waiting for the next scheduled sweep. Fire-and-forget: the user gets
    // their reply immediately either way.
    void pruneOldWallets("after /topup failure");
    await ctx.reply("Could not generate a deposit address. Please try again later.");
  }
}

async function messageHandler(ctx: Context): Promise<void> {
  if (isPaused) {
    await ctx.reply(PAUSED_MESSAGE);
    return;
  }
  await ctx.reply("Send /topup to generate a deposit address, or /help for options.");
}

// ---------------------------------------------------------------------------
// Deposit & withdrawal notifications: webhook receiver -> email
// ---------------------------------------------------------------------------

/** Transaction payload the wallet API posts to our webhook (data field). */
interface WebhookTx {
  amount?: string;
  currency?: string;
  recipient_wallet?: string;
  sender_wallet?: string;
  direction?: "in" | "out";
  status?: string;
  fee?: string;
  hash?: string;
  created?: string;
  user_id?: string;
  external_id?: string;
}

let mailer: ReturnType<typeof nodemailer.createTransport> | null = null;

function getMailer() {
  const mail = config.mail;
  if (!mail) return null;
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
    });
  }
  return mailer;
}

/**
 * Emails a transaction alert. Handles both directions:
 *   - "in"  = deposit received on one of our wallets
 *   - "out" = withdrawal sent from one of our wallets
 */
async function sendTransactionEmail(tx: WebhookTx): Promise<void> {
  const mail = config.mail;
  const transport = getMailer();
  if (!mail || !transport) {
    logger.warn("Transaction event received but email is not configured (set SMTP_HOST + MAIL_TO).");
    return;
  }

  const isDeposit = tx.direction === "in";
  const amount = `${tx.amount ?? "?"} ${tx.currency ?? ""}`.trim();
  const title = isDeposit ? "💰 Deposit received" : "📤 Withdrawal sent";
  const lead = isDeposit
    ? "A deposit was received on a generated wallet."
    : "A withdrawal was sent from a wallet.";
  // For a deposit our wallet is the recipient; for a withdrawal it is the sender.
  const ourWallet = isDeposit ? tx.recipient_wallet : tx.sender_wallet;
  const counterparty = isDeposit ? tx.sender_wallet : tx.recipient_wallet;

  const text = [
    lead,
    ``,
    `Amount:       ${amount}`,
    `Wallet:       ${ourWallet ?? "?"}`,
    `${isDeposit ? "From" : "To"}:         ${counterparty ?? "?"}`,
    tx.fee ? `Fee:          ${tx.fee}` : "",
    `Status:       ${tx.status ?? "?"}`,
    tx.hash ? `Tx hash:      ${tx.hash}` : "",
    tx.created ? `Time:         ${tx.created}` : "",
    tx.external_id ? `External ID:  ${tx.external_id}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await transport.sendMail({
    from: mail.from || mail.user,
    to: mail.to,
    subject: `${title}: ${amount}`,
    text,
  });
  logger.info(`${title} email sent to ${mail.to} (${amount})`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Webhook body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathOnly = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || pathOnly !== config.webhook.path) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: "not_found" }));
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: "bad_request" }));
    return;
  }

  const tx = (payload as { data?: WebhookTx } | null)?.data;
  // direction "in" = deposit, "out" = withdrawal — notify per NOTIFY_DIRECTIONS.
  if (tx?.direction && config.notifyDirections.has(tx.direction)) {
    logger.info(
      `Tx webhook [${tx.direction}]: ${tx.amount} ${tx.currency} (${tx.status})`,
    );
    // Don't let a slow/failing SMTP block the webhook ack.
    sendTransactionEmail(tx).catch((err) => logger.error("sendTransactionEmail failed:", err));
  } else {
    logger.debug(`Webhook ignored (direction=${tx?.direction ?? "none"})`);
  }

  // Always 2xx so the provider doesn't retry endlessly.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ result: "success" }));
}

function startWebhookServer(): void {
  const server = createServer((req, res) => {
    handleWebhook(req, res).catch((err) => {
      logger.error("Webhook handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "error" }));
      }
    });
  });
  server.listen(config.webhook.port, () => {
    logger.info(`Webhook listening on :${config.webhook.port}${config.webhook.path}`);
  });
}

// ---------------------------------------------------------------------------
// Bot setup & startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const bot = new Bot(config.botToken);

  // Request logging.
  bot.use(async (ctx, next) => {
    const from = ctx.from?.username ?? ctx.from?.id ?? "unknown";
    logger.debug(`Update ${ctx.update.update_id} from ${from}`);
    await next();
  });

  // Commands.
  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("topup", topupCommand);
  bot.command("stop", stopCommand); // admin-only pause (handled inside)

  // Fallback text handler (after commands so commands take priority).
  bot.on("message:text", messageHandler);

  // Catch errors so a single bad update never crashes the process.
  bot.catch((err) => {
    logger.error(`Error handling update ${err.ctx.update.update_id}:`, err.error);
  });

  await bot.api.setMyCommands(commandList);

  // Only shut down on a real OS termination signal; /stop just pauses.
  process.once("SIGINT", () => {
    logger.info("SIGINT received, shutting down...");
    void bot.stop();
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down...");
    void bot.stop();
  });

  // Start the deposit-notification webhook receiver.
  startWebhookServer();

  // Recycle old wallets so /topup never hits the provider's 500-wallet cap.
  startWalletPruneSchedule();

  const mail = config.mail;
  if (mail) {
    getMailer()
      ?.verify()
      .then(() => logger.info(`Email notifications enabled -> ${mail.to}`))
      .catch((err) => logger.error("SMTP verify failed (emails may not send):", err));
  } else {
    logger.warn("Email notifications disabled (set SMTP_HOST and MAIL_TO to enable).");
  }

  logger.info("Starting bot (long polling)...");
  await bot.start({
    onStart: (info) => logger.info(`Bot @${info.username} is up and running`),
  });
}

// Keep the process alive even if a stray error escapes a handler — the bot
// should stay on once started.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
});

main().catch((err) => {
  logger.error("Fatal error during startup:", err);
  process.exit(1);
});
