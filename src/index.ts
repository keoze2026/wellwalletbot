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

interface CreateWalletResponse {
  code: string;
  data: WalletData;
}

/** Documented error envelope: { error_message, code, error_code }. */
interface ApiErrorBody {
  error_message?: string;
  code?: string;
  error_code?: string;
}

/**
 * Calls POST /wallets to create a brand-new wallet address. The auth key is
 * sent in the `token` header.
 */
async function createTrc20Wallet(name: string): Promise<WalletData> {
  const url = `${config.walletApi.baseUrl}/wallets`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        token: config.walletApi.token,
      },
      body: JSON.stringify({ name, network: "trx", type: config.walletApi.walletType }),
    });
  } catch (err) {
    logger.error("Wallet API request failed (network error):", err);
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
    // A plain-text body from the load balancer (no JSON) means the request was
    // blocked at the network edge — almost always an IP allowlist / WAF rule,
    // not an app-level error.
    if (typeof parsed !== "object") {
      logger.error(
        `Wallet API edge-blocked (${res.status}) — source IP likely not allowlisted by the provider. Body: ${String(parsed)}`,
      );
      throw new Error(`Wallet provider blocked the request (${res.status})`);
    }
    const body = parsed as ApiErrorBody;
    logger.error(
      `Wallet API POST /wallets -> ${res.status} ${body.error_code ?? ""}: ${body.error_message ?? "(no message)"}`,
    );
    throw new Error(body.error_message || `Wallet provider returned ${res.status}`);
  }

  const data = (parsed as CreateWalletResponse | undefined)?.data;
  if (!data?.address) {
    logger.error("Wallet API response missing address:", parsed);
    throw new Error("Wallet provider returned no address");
  }
  return data;
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
