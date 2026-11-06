/**
 * Read-only lookup for one or more addresses: does the provider still hold it,
 * who was it created for, and what is its balance.
 *
 * Deletes nothing and writes nothing. Safe to run any time.
 *
 * The provider's API has no single-wallet endpoint — only POST, GET (paged) and
 * DELETE on /wallets — so this walks the whole account list and matches. Age and
 * owner come from the name /topup assigns: `tg-<telegramId>-<epochMs>`.
 *
 * Usage (from the project root, on a host whose IP is allowlisted):
 *
 *   node scripts/lookup-wallet.mjs TMCkpnDrHRT3s8UeQ9W2hvgGKzGzekwX41
 *   node scripts/lookup-wallet.mjs TAddr1 TAddr2 TAddr3     # several at once
 *   node scripts/lookup-wallet.mjs TAddr --onchain          # also query TronGrid
 *   node scripts/lookup-wallet.mjs TAddr --json
 *
 * NOT FOUND means the provider has no such wallet on this account right now. It
 * does not prove the address was never issued — the scheduled prune and
 * delete-all-wallets.mjs both remove addresses permanently, and the API keeps no
 * record of a deleted one. To tell "never created" from "created and deleted",
 * search the bot's own logs on the VPS:
 *
 *   grep -r "<address>" ~/.pm2/logs/ /root/wellwalletbot/*.log
 *
 * A /topup line means the bot issued it; a "Wallet prune: deleted" line means
 * the bot later destroyed it.
 *
 * --onchain additionally asks TronGrid (api.trongrid.io, a public explorer API)
 * what the address holds on the TRON network. That sends the address to a
 * third-party service, which is why it is opt-in; no token or secret is sent.
 * It answers a question the provider cannot once a wallet is deleted: whether
 * USDT is still sitting on the address.
 */
import "dotenv/config";

const BASE_URL = process.env.WALLET_API_BASE_URL;
const TOKEN = process.env.WALLET_API_TOKEN;

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

// TRC20 USDT on mainnet, 6 decimals.
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRONGRID = "https://api.trongrid.io";

const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const ONCHAIN = argv.includes("--onchain");
const addresses = argv.filter((a) => !a.startsWith("--"));

if (addresses.length === 0) {
  console.error("Usage: node scripts/lookup-wallet.mjs <address> [more addresses] [--onchain] [--json]");
  process.exit(1);
}
if (!BASE_URL || !TOKEN) {
  console.error("Missing WALLET_API_BASE_URL or WALLET_API_TOKEN — run this from the project root.");
  process.exit(1);
}

// A TRON base58 address: "T" plus 33 base58 characters. Catches a truncated or
// mistyped paste before it is reported as a confident "not found".
const looksLikeTron = (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
for (const a of addresses) {
  if (!looksLikeTron(a)) {
    console.error(`"${a}" is not a valid TRON address (expected T + 33 base58 chars, got ${a.length} chars).`);
    process.exit(1);
  }
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
    if (!AS_JSON) process.stdout.write(`  scanned ${all.length} wallets\r`);
    if (batch.length < PAGE_SIZE) break;
  }
  if (!AS_JSON) process.stdout.write("\n");
  return all;
}

/**
 * Token balances as a {TICKER: number} map. Number(null) and Number("") are
 * both 0, so a missing amount read naively looks like a confirmed empty wallet;
 * anything missing or unparseable is flagged unreadable instead of counted.
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

/** Mirrors createdAtFromName() in src/index.ts — keep the two in step. */
function parseName(name) {
  const parts = (name ?? "").split("-");
  if (parts.length < 3 || parts[0] !== "tg") return null;
  const ms = Number(parts[parts.length - 1]);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { createdAt: ms, userId: parts.slice(1, -1).join("-") };
}

const formatBalance = (byTicker, unreadable) => {
  const parts = Object.entries(byTicker)
    .filter(([, n]) => n !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([ticker, n]) => `${n} ${ticker}`);
  if (parts.length === 0) return unreadable ? "unreadable" : "0 (empty)";
  return parts.join(", ") + (unreadable ? " (+unreadable)" : "");
};

const ageOf = (ms) => {
  const hours = (Date.now() - ms) / 3_600_000;
  return hours < 48 ? `${Math.round(hours)}h old` : `${Math.round(hours / 24)}d old`;
};

/** Public explorer lookup — no provider credentials involved. */
async function onchain(address) {
  const res = await fetch(`${TRONGRID}/v1/accounts/${address}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`TronGrid HTTP ${res.status}`);
  const body = await res.json();
  const account = body?.data?.[0];
  if (!account) {
    // TRON only records an address once it has been funded or used.
    return { activated: false, trx: 0, usdt: 0, otherTrc20: {} };
  }
  const trc20 = Object.assign({}, ...(account.trc20 ?? []));
  const usdtRaw = trc20[USDT_CONTRACT];
  const otherTrc20 = {};
  for (const [contract, amount] of Object.entries(trc20)) {
    if (contract !== USDT_CONTRACT) otherTrc20[contract] = amount;
  }
  return {
    activated: true,
    trx: Number(account.balance ?? 0) / 1e6,
    usdt: usdtRaw === undefined ? 0 : Number(usdtRaw) / 1e6,
    otherTrc20,
  };
}

async function main() {
  const wallets = await listAllWallets();
  const byAddress = new Map(wallets.map((w) => [w.address, w]));

  const results = [];
  for (const address of addresses) {
    const entry = byAddress.get(address);
    const result = { address, foundOnProvider: Boolean(entry) };

    if (entry) {
      const { byTicker, unreadable } = readBalances(entry);
      const parsed = parseName(entry.name);
      Object.assign(result, {
        name: entry.name ?? null,
        botCreated: parsed !== null,
        telegramUserId: parsed?.userId ?? null,
        createdAt: parsed ? new Date(parsed.createdAt).toISOString() : null,
        age: parsed ? ageOf(parsed.createdAt) : null,
        type: entry.type ?? null,
        network: entry.network ?? null,
        status: entry.status ?? null,
        balances: byTicker,
        balanceUnreadable: unreadable,
      });
    }

    if (ONCHAIN) {
      try {
        result.onchain = await onchain(address);
      } catch (err) {
        result.onchain = { error: String(err?.message ?? err) };
      }
    }
    results.push(result);
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ walletsScanned: wallets.length, results }, null, 2));
    return;
  }

  for (const r of results) {
    console.log(`\n================ ${r.address} ================`);
    if (r.foundOnProvider) {
      console.log(`Status:            FOUND on the provider account`);
      console.log(`Balance:           ${formatBalance(r.balances, r.balanceUnreadable)}`);
      console.log(`Name:              ${r.name ?? "(unnamed)"}`);
      if (r.botCreated) {
        console.log(`Created by:        this bot, for Telegram user ${r.telegramUserId}`);
        console.log(`Created at:        ${r.createdAt}  (${r.age})`);
      } else {
        console.log(`Created by:        NOT this bot (name is not tg-<userId>-<epochMs>)`);
        console.log(`Created at:        unknown — the API returns no timestamp`);
      }
      if (r.type) console.log(`Type:              ${r.type}`);
      if (r.network) console.log(`Network:           ${r.network}`);
      if (r.status) console.log(`Provider status:   ${r.status}`);
      if (r.balanceUnreadable) {
        console.log(`\nNote: at least one balance field was missing or unparseable, so the`);
        console.log(`figure above may understate what the address holds.`);
      }
    } else {
      console.log(`Status:            NOT FOUND among the ${wallets.length} wallets on this account`);
      console.log(`\nThat means one of:`);
      console.log(`  - it was never created by this bot or on this account;`);
      console.log(`  - it was created and has since been deleted (the scheduled prune, or`);
      console.log(`    delete-all-wallets.mjs) — deletion is permanent and leaves no record;`);
      console.log(`  - it belongs to a different provider account or the address is mistyped.`);
      console.log(`\nTo tell those apart, search this VPS's logs:`);
      console.log(`  grep -r "${r.address}" ~/.pm2/logs/ /root/wellwalletbot/*.log`);
    }

    if (r.onchain) {
      console.log("\n--- ON-CHAIN (TronGrid, public explorer) ---");
      if (r.onchain.error) {
        console.log(`  lookup failed: ${r.onchain.error}`);
      } else if (!r.onchain.activated) {
        console.log(`  Address has no on-chain record — it has never received anything.`);
      } else {
        console.log(`  USDT (TRC20):    ${r.onchain.usdt}`);
        console.log(`  TRX:             ${r.onchain.trx}`);
        const others = Object.entries(r.onchain.otherTrc20);
        if (others.length > 0) {
          console.log(`  Other TRC20:     ${others.map(([c, a]) => `${c}=${a}`).join(", ")}`);
        }
        if (!r.foundOnProvider && r.onchain.usdt > 0) {
          console.log(`\n  ⚠️  The provider no longer holds this wallet but the address still has`);
          console.log(`      USDT on it. Deleted wallets are only recoverable through WellWallet`);
          console.log(`      support — contact them with this address.`);
        }
      }
    }
    console.log("=".repeat(36 + r.address.length + 2));
  }
  console.log();
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
