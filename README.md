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
