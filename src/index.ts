import "dotenv/config";
import { Bot, InputFile, type Context } from "grammy";

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

const config = {
  botToken: required("BOT_TOKEN"),
  logLevel: optional("LOG_LEVEL", "info"),
  adminIds: parseIds(optional("ADMIN_IDS", "")),
  walletApi: {
    baseUrl: required("WALLET_API_BASE_URL"),
    token: required("WALLET_API_TOKEN"),
    walletType: walletTypeFrom(optional("WALLET_TYPE", "accounting")),
  },
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
