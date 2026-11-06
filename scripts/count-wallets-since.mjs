/**
 * Read-only report: how many addresses this bot has generated since a cutoff —
 * by default, since the last full wipe.
 *
 * Deletes nothing and writes nothing. Safe to run any time.
 *
 * The provider's GET /wallets returns no creation timestamp, so age comes from
 * the name /topup assigns every wallet: `tg-<telegramId>-<epochMs>`. Wallets
 * named any other way (manual, aggregation) have no recoverable age and are
 * reported separately as "not bot-created".
 *
 * The cutoff is chosen in this order:
 *   1. --since <value>      explicit
 *   2. .last-wallet-delete  file holding an ISO date or epoch ms, if present
 *   3. none                 count every bot wallet on the account — which IS the
 *                           answer after a delete-all, since the wipe left
 *                           nothing behind
 *
 * --since accepts an ISO date (2026-11-01, 2026-11-01T09:30:00Z), epoch ms or
 * seconds, or a relative age (90m, 24h, 7d).
 *
 * Usage (from the project root, on a host whose IP is allowlisted):
 *
 *   node scripts/count-wallets-since.mjs                      # since the last wipe
 *   node scripts/count-wallets-since.mjs --since 24h          # last 24 hours
 *   node scripts/count-wallets-since.mjs --since 2026-11-01   # since a date
 *   node scripts/count-wallets-since.mjs --by-day --by-user   # add breakdowns
 *   node scripts/count-wallets-since.mjs --balances           # list EVERY wallet, zeros included
 *   node scripts/count-wallets-since.mjs --no-list            # summary only
 *   node scripts/count-wallets-since.mjs --json               # machine-readable
 *
 * Each wallet is printed as `address — balance — name (age)`. By default only
 * wallets holding something (or whose balance will not parse) are listed, since
 * a post-wipe account is mostly empty addresses; --balances lists them all.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

const BASE_URL = process.env.WALLET_API_BASE_URL;
const TOKEN = process.env.WALLET_API_TOKEN;

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const PROVIDER_CAP = 500;
const MARKER_FILE = ".last-wallet-delete";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const AS_JSON = has("json");
const BY_DAY = has("by-day");
const BY_USER = has("by-user");
const ALL_BALANCES = has("balances"); // list every wallet, zero-balance included
const NO_LIST = has("no-list"); // summary only

if (!BASE_URL || !TOKEN) {
  console.error("Missing WALLET_API_BASE_URL or WALLET_API_TOKEN — run this from the project root.");
  process.exit(1);
}

/** ISO date, epoch seconds/ms, or a relative age like 90m / 24h / 7d -> epoch ms. */
function parseSince(raw) {
  const value = String(raw).trim();
  const relative = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(value);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2].toLowerCase()];
    return Date.now() - Number(relative[1]) * unit;
  }
  if (/^\d{10}$/.test(value)) return Number(value) * 1000; // epoch seconds
  if (/^\d+$/.test(value)) return Number(value); // epoch ms
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Could not read --since "${raw}" as a date, epoch or age.`);
  return parsed;
}

function resolveCutoff() {
  const explicit = flag("since");
  if (explicit !== undefined) return { since: parseSince(explicit), source: `--since ${explicit}` };
  try {
    const marker = readFileSync(MARKER_FILE, "utf8").trim();
    if (marker) return { since: parseSince(marker), source: `${MARKER_FILE} (${marker})` };
  } catch {
    // No marker file — fall through to counting the whole account.
  }
  return {
    since: null,
    source: "whole account (nothing survives a delete-all, so this is the post-wipe count)",
  };
}

async function api(method, path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", token: TOKEN },
  });
  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }
  if (!res.ok) {
    // The live API answers in camelCase even though the docs say snake_case.
    const message =
      (parsed && typeof parsed === "object" && (parsed.errorMessage ?? parsed.error_message)) ||
      `HTTP ${res.status}: ${String(raw).slice(0, 200)}`;
    throw new Error(message);
  }
  return parsed?.data;
}

async function listAllWallets() {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await api("GET", `/wallets?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`);
    const batch = data?.wallets ?? [];
    all.push(...batch);
    if (!AS_JSON) process.stdout.write(`  fetched ${all.length} wallets\r`);
    if (batch.length < PAGE_SIZE) break;
  }
  if (!AS_JSON) process.stdout.write("\n");
  return all;
}

/**
 * Same parse the scheduled prune uses, so this report and the prune agree on
 * which wallets are bot-created and how old they are. Mirrors
 * createdAtFromName() in src/index.ts — keep the two in step.
 */
function parseName(name) {
  const parts = (name ?? "").split("-");
  if (parts.length < 3 || parts[0] !== "tg") return null;
  const ms = Number(parts[parts.length - 1]);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { createdAt: ms, userId: parts.slice(1, -1).join("-") };
}

/**
 * Token balances for one list entry as a plain {TICKER: number} map.
 *
 * Number(null) and Number("") are both 0, so a missing amount read naively
 * would look like a confirmed zero and under-report what is actually held.
 * Anything missing or unparseable is flagged unreadable instead of counted.
 */
function readBalances(entry) {
  const balances = entry?.balances;
  const byTicker = {};
  if (!balances || typeof balances !== "object" || Object.keys(balances).length === 0) {
    return { byTicker, unreadable: true };
  }
  let unreadable = false;
  for (const [ticker, balance] of Object.entries(balances)) {
    const raw = balance?.available;
    const missing = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
    const amount = missing ? NaN : Number(raw);
    if (!Number.isFinite(amount)) {
      unreadable = true;
      continue;
    }
    byTicker[ticker] = (byTicker[ticker] ?? 0) + amount;
  }
  return { byTicker, unreadable };
}

const holdsFunds = (byTicker) => Object.values(byTicker).some((n) => n > 0);

/** "12.5 USDT, 3 TRX", or "0" when every readable balance is zero. */
function formatBalance(byTicker, unreadable) {
  const parts = Object.entries(byTicker)
    .filter(([, n]) => n !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([ticker, n]) => `${n} ${ticker}`);
  if (parts.length === 0) return unreadable ? "unreadable" : "0";
  return parts.join(", ") + (unreadable ? " (+unreadable)" : "");
}

function addTotals(into, byTicker) {
  for (const [ticker, n] of Object.entries(byTicker)) {
    if (n > 0) into[ticker] = (into[ticker] ?? 0) + n;
  }
}

const ageOf = (ms) => {
  const hours = (Date.now() - ms) / 3_600_000;
  return hours < 48 ? `${Math.round(hours)}h old` : `${Math.round(hours / 24)}d old`;
};

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const { since, source } = resolveCutoff();
  const wallets = await listAllWallets();

  const bot = [];
  let foreign = 0;
  let foreignFunded = 0;
  const accountTotals = {};
  for (const w of wallets) {
    const { byTicker, unreadable } = readBalances(w);
    addTotals(accountTotals, byTicker);
    const parsed = parseName(w.name);
    if (!parsed) {
      foreign++;
      if (holdsFunds(byTicker)) foreignFunded++;
      continue;
    }
    bot.push({ ...parsed, address: w.address, name: w.name, balances: byTicker, unreadable });
  }

  const matched = since === null ? bot.slice() : bot.filter((w) => w.createdAt >= since);
  matched.sort((a, b) => a.createdAt - b.createdAt);

  const users = new Map();
  const days = new Map();
  const windowTotals = {};
  let funded = 0;
  let unreadable = 0;
  for (const w of matched) {
    users.set(w.userId, (users.get(w.userId) ?? 0) + 1);
    days.set(day(w.createdAt), (days.get(day(w.createdAt)) ?? 0) + 1);
    addTotals(windowTotals, w.balances);
    if (holdsFunds(w.balances)) funded++;
    if (w.unreadable) unreadable++;
  }
  const sortedTotals = (totals) => Object.entries(totals).sort((a, b) => b[1] - a[1]);

  const oldest = matched[0];
  const newest = matched[matched.length - 1];

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          cutoff: since === null ? null : new Date(since).toISOString(),
          cutoffSource: source,
          generatedSinceCutoff: matched.length,
          walletsOnAccount: wallets.length,
          botCreated: bot.length,
          notBotCreated: foreign,
          uniqueUsers: users.size,
          firstInWindow: oldest ? new Date(oldest.createdAt).toISOString() : null,
          latestInWindow: newest ? new Date(newest.createdAt).toISOString() : null,
          capHeadroom: PROVIDER_CAP - wallets.length,
          fundedInWindow: funded,
          balanceUnreadableInWindow: unreadable,
          notBotCreatedFunded: foreignFunded,
          balanceTotalsInWindow: Object.fromEntries(sortedTotals(windowTotals)),
          balanceTotalsAccountWide: Object.fromEntries(sortedTotals(accountTotals)),
          perDay: Object.fromEntries([...days].sort()),
          perUser: Object.fromEntries([...users].sort((a, b) => b[1] - a[1])),
          wallets: matched.map((w) => ({
            address: w.address,
            name: w.name,
            userId: w.userId,
            createdAt: new Date(w.createdAt).toISOString(),
            balances: w.balances,
            balanceUnreadable: w.unreadable,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("\n============== ADDRESSES GENERATED ==============");
  console.log(`Counting since:            ${since === null ? "(no cutoff)" : new Date(since).toISOString()}`);
  console.log(`  cutoff from:             ${source}`);
  console.log(`\nGenerated in window:       ${matched.length}`);
  console.log(`  distinct Telegram users: ${users.size}`);
  console.log(`  holding a balance:       ${funded}`);
  console.log(`  balance unreadable:      ${unreadable}`);
  if (oldest) console.log(`  first in window:         ${new Date(oldest.createdAt).toISOString()}  (${oldest.name})`);
  if (newest) console.log(`  latest in window:        ${new Date(newest.createdAt).toISOString()}  (${newest.name})`);

  console.log("\nBALANCE HELD IN WINDOW:");
  const windowLines = sortedTotals(windowTotals);
  if (windowLines.length === 0) console.log("  (none — every readable balance is zero)");
  else for (const [ticker, amount] of windowLines) console.log(`  ${ticker.padEnd(8)} ${amount}`);

  console.log(`\nWallets on account now:    ${wallets.length}`);
  console.log(`  bot-created (tg-…):      ${bot.length}`);
  console.log(`  not bot-created:         ${foreign}  (${foreignFunded} holding a balance)`);
  console.log(`  headroom to ${PROVIDER_CAP} cap:     ${PROVIDER_CAP - wallets.length}`);
  const accountLines = sortedTotals(accountTotals);
  if (accountLines.length > 0) {
    console.log(`  account-wide balance:    ${accountLines.map(([t, n]) => `${n} ${t}`).join(", ")}`);
  }

  // The listing the report exists for: one line per wallet, address and balance.
  if (!NO_LIST) {
    const listed = ALL_BALANCES ? matched : matched.filter((w) => holdsFunds(w.balances) || w.unreadable);
    console.log(
      `\nWALLET — BALANCE  (${
        ALL_BALANCES ? `all ${listed.length} in window` : `${listed.length} funded or unreadable; --balances for all`
      }):`,
    );
    if (listed.length === 0) {
      console.log("  (no wallet in the window holds a readable balance)");
    } else {
      for (const w of listed) {
        const balance = formatBalance(w.balances, w.unreadable);
        console.log(`  ${w.address.padEnd(36)} ${balance.padEnd(22)} ${w.name}  (${ageOf(w.createdAt)})`);
      }
    }
  }

  if (BY_DAY && days.size > 0) {
    console.log("\nPER DAY (UTC):");
    for (const [d, n] of [...days].sort()) {
      console.log(`  ${d}  ${String(n).padStart(4)}  ${"#".repeat(Math.min(n, 50))}`);
    }
  }
  if (BY_USER && users.size > 0) {
    console.log("\nPER USER (top 20):");
    for (const [u, n] of [...users].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${u.padEnd(14)} ${String(n).padStart(4)}`);
    }
  }
  console.log("=================================================\n");

  if (since === null) {
    console.log("No delete marker found, so this is every bot wallet currently on the account.");
    console.log(`After your next wipe, run:  date -u +%FT%TZ > ${MARKER_FILE}`);
    console.log("and later runs will count only what came after it.\n");
  }
}

main().catch((err) => {
  const message = String(err?.message ?? err);
  console.error(`\nFAILED: ${message}`);
  if (message.includes("403")) {
    console.error(
      "A bare 403 means this machine's IP is not on the provider's allowlist.\n" +
        "Run this on the VPS, not your laptop.",
    );
  }
  process.exit(1);
});
