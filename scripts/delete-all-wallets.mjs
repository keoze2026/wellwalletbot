/**
 * One-off maintenance script: DELETES EVERY WALLET on the account.
 *
 * This is deliberately destructive and deliberately NOT part of the bot. It
 * ignores every guard the scheduled prune applies — balance, age and ownership
 * are all disregarded. Any USDT held on a deleted address becomes recoverable
 * only through WellWallet support.
 *
 * Usage (from the project root, on a host whose IP is allowlisted):
 *
 *   node scripts/delete-all-wallets.mjs            # census only, deletes nothing
 *   node scripts/delete-all-wallets.mjs --yes      # census, then deletes everything
 *
 * The census is always printed first so the balance about to be destroyed is
 * visible before anything is removed.
 */
import "dotenv/config";
import { appendFileSync } from "node:fs";

const BASE_URL = process.env.WALLET_API_BASE_URL;
const TOKEN = process.env.WALLET_API_TOKEN;
const CONFIRMED = process.argv.includes("--yes");

const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const DELETE_DELAY_MS = 150;
const FAILURE_LOG = "delete-all-failures.log";

if (!BASE_URL || !TOKEN) {
  console.error("Missing WALLET_API_BASE_URL or WALLET_API_TOKEN — run this from the project root.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", token: TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    process.stdout.write(`  fetched ${all.length} wallets\r`);
    if (batch.length < PAGE_SIZE) break;
  }
  process.stdout.write("\n");
  return all;
}

/** Sums every token balance across the account, so nothing is destroyed blind. */
function census(wallets) {
  const totals = {};
  let funded = 0;
  let unreadable = 0;
  let botCreated = 0;

  for (const w of wallets) {
    const parts = (w.name ?? "").split("-");
    if (parts.length >= 3 && parts[0] === "tg" && Number.isFinite(Number(parts.at(-1)))) {
      botCreated++;
    }
    const balances = w.balances;
    if (!balances || typeof balances !== "object" || Object.keys(balances).length === 0) {
      unreadable++;
      continue;
    }
    let holds = false;
    for (const [ticker, balance] of Object.entries(balances)) {
      const raw = balance?.available;
      // Number(null) and Number("") are both 0. Counting those as a confirmed
      // zero would under-report the balance about to be destroyed.
      const missing = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
      const available = missing ? NaN : Number(raw);
      if (!Number.isFinite(available)) {
        unreadable++;
        continue;
      }
      if (available > 0) {
        totals[ticker] = (totals[ticker] ?? 0) + available;
        holds = true;
      }
    }
    if (holds) funded++;
  }
  return { totals, funded, unreadable, botCreated };
}

async function main() {
const wallets = await listAllWallets();
const { totals, funded, unreadable, botCreated } = census(wallets);
const tokenLines = Object.entries(totals).sort((a, b) => b[1] - a[1]);

console.log("\n=================== WALLET CENSUS ===================");
console.log(`Total wallets:            ${wallets.length}`);
console.log(`Created by this bot:      ${botCreated}`);
console.log(`Created elsewhere:        ${wallets.length - botCreated}`);
console.log(`Holding a balance:        ${funded}`);
console.log(`Balance unreadable:       ${unreadable}`);
console.log("\nBALANCE THAT WILL BE DESTROYED:");
if (tokenLines.length === 0) {
  console.log("  (none detected — every readable balance is zero)");
} else {
  for (const [ticker, amount] of tokenLines) {
    console.log(`  ${ticker.padEnd(8)} ${amount}`);
  }
}
console.log("=====================================================\n");

if (!CONFIRMED) {
  console.log("Census only — nothing deleted.");
  console.log("Re-run with --yes to delete all wallets, including the balances listed above.");
  process.exit(0);
}

if (funded > 0 || tokenLines.length > 0) {
  console.log(`⚠️  ${funded} wallets hold funds. Deleting in 10 seconds — Ctrl+C to abort.`);
  await sleep(10_000);
}

console.log(`Deleting ${wallets.length} wallets...\n`);
let deleted = 0;
let failed = 0;

for (const [index, wallet] of wallets.entries()) {
  try {
    await api("DELETE", "/wallets", { address: wallet.address });
    deleted++;
    console.log(`[${index + 1}/${wallets.length}] deleted ${wallet.address} (${wallet.name ?? "unnamed"})`);
  } catch (err) {
    failed++;
    const line = `${stamp()} ${wallet.address} (${wallet.name ?? "unnamed"}): ${err.message}`;
    console.error(`[${index + 1}/${wallets.length}] FAILED ${line}`);
    appendFileSync(FAILURE_LOG, `${line}\n`);
  }
  await sleep(DELETE_DELAY_MS);
}

console.log(`\nDone. Deleted ${deleted}, failed ${failed}.`);
if (failed > 0) console.log(`Failures logged to ${FAILURE_LOG} — re-run to retry them.`);

const remaining = await listAllWallets();
console.log(`Wallets remaining on the account: ${remaining.length}`);
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
