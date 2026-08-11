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
`WALLET_PRUNE_THRESHOLD` (350) wallets, it deletes the **oldest** wallets back
down to that threshold, at most `WALLET_PRUNE_MAX_PER_RUN` (200) per sweep.

> ⚠️ **Balance and age are not checked.** A wallet still holding USDT is deleted
> along with the rest, and [the docs](https://docs.wellwallet.io/api-reference/wallets/delete-wallet)
> warn that funds sent to a deleted address are recoverable only by contacting
> provider support. This is a deliberate choice — deposits landing on an old
> address are expected to be swept before the address ages out.

The only wallets touched are those named `tg-<userId>-<epochMs>` by `/topup`.
That is **not** a safety filter: the API returns no creation timestamp, so the
name is the sole way to order wallets by age. A wallet named any other way —
manually created, or an aggregation wallet — has no recoverable age and is
therefore left alone.

Set `WALLET_PRUNE_DRY_RUN=true` to log what a sweep *would* delete without
deleting anything, or `WALLET_PRUNE_ENABLED=false` to stop sweeping entirely.

To wipe the account completely, `scripts/delete-all-wallets.mjs` deletes every
wallet regardless of name, age or balance. See the header of that file.

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
