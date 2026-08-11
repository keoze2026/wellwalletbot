# TOPUP Bot

A Telegram bot built with **TypeScript** and [grammY](https://grammy.dev).

## Project structure

```
TOPUP/
├── src/
│   └── index.ts            # The whole bot: config, logger, API client,
│                           # commands (/start, /help, /topup), startup
├── .env                    # Your secrets (gitignored)
├── .env.example            # Template — copy to .env
├── .gitignore              # Ignores node_modules, dist, .env, .claude
├── package.json
├── tsconfig.json
└── README.md
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.

3. Copy the env template and fill in your token:

   ```bash
   cp .env.example .env
   ```

   Then set `BOT_TOKEN` and `WALLET_API_TOKEN` in `.env`.

## The `/topup` command

`/topup` calls the wallet API — `POST /wallets` with
`{ network: "trx", type: "user" }` and a unique `name` — so it generates a
**brand-new TRC20 (USDT-TRON) address every time it is run**. The auth key is
sent in the `token` header. The bot replies with the address (and a QR image
when the API returns one).

## Wallet pruning (the 500-wallet cap)

The provider caps an account at **500 wallets**. Once that cap is hit,
`POST /wallets` answers `404` and `/topup` stops working — so the bot recycles
old addresses automatically.

A sweep runs at startup, every `WALLET_PRUNE_INTERVAL_HOURS`, and immediately
after any `/topup` failure. When the account holds more than
`WALLET_PRUNE_THRESHOLD` (350) wallets, it scans the oldest
`WALLET_PRUNE_WINDOW` (200) and deletes **only those with a zero balance**.

Deletion is irreversible — [the docs](https://docs.wellwallet.io/api-reference/wallets/delete-wallet)
warn that funds sent to a deleted address are inaccessible without provider
support. Three guards make a wallet safe to delete, and all must hold:

| Guard | Why |
| --- | --- |
| Explicit zero on every token | Never destroy an address holding funds. Missing or unreadable balance data counts as *unknown*, not empty — the wallet is skipped |
| Balance re-read immediately before deleting | The listing can be a minute old by the time the queue drains; a deposit landing in that gap must not be deleted with the wallet |
| Older than `WALLET_PRUNE_MIN_AGE_HOURS` (24h) | A user may still pay into an address `/topup` just issued |
| Name matches `tg-<userId>-<epochMs>` | Only wallets this bot created; manual and aggregation wallets are untouchable |

The API returns **no creation timestamp**, so wallet age comes from the `name`
`/topup` assigns at creation. Wallets named any other way have no recoverable
age and are therefore never pruned.

Set `WALLET_PRUNE_DRY_RUN=true` to log what a sweep *would* delete without
deleting anything.

**Residual risk this does not remove:** a user who was issued an address more
than 24h ago, whose wallet is empty at sweep time, and who pays *after* the
sweep deletes it. Their deposit lands on a deleted address and needs provider
support to recover. Raising `WALLET_PRUNE_MIN_AGE_HOURS` narrows the window but
cannot close it — only expiring addresses in the `/topup` message can.

## Scripts

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `npm run dev`     | Run in watch mode (tsx, no build needed)     |
| `npm run build`   | Compile TypeScript to `dist/`                |
| `npm start`       | Run the compiled bot from `dist/`            |
| `npm run typecheck` | Type-check without emitting                |

## Adding features

The whole bot lives in `src/index.ts`. To add a command, define a handler
function, register it with `bot.command("<name>", handler)`, and add an entry
to `commandList` so it shows in the Telegram menu.
