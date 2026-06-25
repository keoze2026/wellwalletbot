# Deposit & Withdrawal Email Notifications

Email alerts whenever a generated wallet **receives a deposit** or **sends a
withdrawal**, deployed on a Hostinger VPS.

---

## 1. How it works (per the API docs)

The wallet API has **no email feature**. Its only transaction-event mechanism is
an **outgoing webhook** (`ClientTransactionWebhookData`) that it POSTs to a URL
you configure. Each callback includes a `direction` field:

| `direction` | Meaning | "Our" wallet | Counterparty |
|---|---|---|---|
| `in`  | Deposit received | `recipient_wallet` | `sender_wallet` |
| `out` | Withdrawal sent  | `sender_wallet`    | `recipient_wallet` |

So the bot runs a small HTTP server that receives these callbacks and emails you
(via SMTP) on each event. Flow:

```
Wallet API  ──POST {direction,amount,currency,…}──▶  bot webhook (:8080)
                                                         │
                                                         ├─ direction in NOTIFY_DIRECTIONS?
                                                         │     └─ yes ─▶ send email (SMTP) ─▶ MAIL_TO
                                                         └─ reply 200 {"result":"success"}
```

The webhook always replies `200 {"result":"success"}` so the provider doesn't
retry, and email is sent asynchronously so a slow SMTP server never blocks the
ack.

---

## 2. Requirements

**On the VPS**
- Node.js 20+ and npm
- pm2 (process manager)
- The bot deployed at `~/wellwalletbot` with a working `.env`
- An open inbound port for the webhook (default `8080`), or a reverse proxy
- The server's public IP **allowlisted by the provider for prod** (already done:
  `168.231.112.65`)

**From the wallet provider (via support — there is no API for these)**
- Your **webhook URL** registered: `http://<vps-ip>:8080/webhook/<secret>`
- Confirmation of whether they require **HTTPS** (see §6)

**Email sending (one of)**
- A **Gmail account + App Password** (needs 2-Step Verification), or
- Any SMTP service (Brevo / SendGrid / Mailgun / Outlook / your host)

**Code dependency** (already in `package.json`): `nodemailer`.

---

## 3. Configuration (`.env`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WEBHOOK_PORT` | no | `8080` | Port the webhook server listens on |
| `WEBHOOK_PATH` | **yes** | `/webhook` | Callback path — **put a long random secret in it**; exact-match is the auth |
| `NOTIFY_DIRECTIONS` | no | `in,out` | Which events email you: `in`, `out`, or `in,out` |
| `SMTP_HOST` | **yes (for email)** | — | SMTP server host |
| `SMTP_PORT` | no | `587` | SMTP port (`587` STARTTLS, `465` SSL) |
| `SMTP_SECURE` | no | `false` | `true` only for port `465` |
| `SMTP_USER` | yes | — | SMTP login |
| `SMTP_PASS` | yes | — | SMTP password / app password |
| `MAIL_FROM` | no | = `SMTP_USER` | From address (Gmail requires = `SMTP_USER`) |
| `MAIL_TO` | **yes (for email)** | — | Where alerts are delivered |

If `SMTP_HOST` or `MAIL_TO` is blank, email is **disabled** (bot still runs; the
webhook still acks). Startup logs say which.

### Gmail App Password
1. Enable 2-Step Verification: <https://myaccount.google.com/security>
2. Create an App Password: <https://myaccount.google.com/apppasswords> → copy the
   16 characters (drop the spaces) → use as `SMTP_PASS`.

Gmail SMTP does **not** require you to own a domain.

### Example `.env` block
```bash
WEBHOOK_PORT=8080
WEBHOOK_PATH=/webhook/3b9c1f7e2a8d4c5f6071829aabbccdde
NOTIFY_DIRECTIONS=in,out
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_FROM=you@gmail.com
MAIL_TO=keoze2026@gmail.com
```

### Other SMTP presets
| Provider | SMTP_HOST | SMTP_PORT | SMTP_SECURE |
|---|---|---|---|
| Gmail | smtp.gmail.com | 587 | false |
| Outlook/Office365 | smtp.office365.com | 587 | false |
| Brevo | smtp-relay.brevo.com | 587 | false |
| SendGrid | smtp.sendgrid.net | 587 | false |
| Mailgun | smtp.mailgun.org | 587 | false |

---

## 4. Deployment guide (Hostinger VPS)

```bash
ssh root@<vps-ip>
cd ~/wellwalletbot

# 1. Pull the new code
git pull                 # or scp src/index.ts package.json package-lock.json

# 2. Install the new dependency (REQUIRED — package.json changed)
npm install

# 3. Build (only if you run the compiled dist/ version)
npm run build

# 4. Edit secrets
nano .env                # set WEBHOOK_PATH secret + SMTP_* + MAIL_TO (see §3)

# 5. Open the webhook port
ufw allow 8080

# 6. Restart
pm2 restart wellwalletbot
pm2 logs wellwalletbot
```

Healthy startup logs show:
```
Webhook listening on :8080/webhook/<secret>
Email notifications enabled -> keoze2026@gmail.com
Bot @<name> is up and running
```
(If you see `Email notifications disabled`, `SMTP_HOST`/`MAIL_TO` are blank.)

**7. Register the webhook URL with the provider** (support):
```
http://168.231.112.65:8080/webhook/<your-secret>
```

---

## 5. Testing (no real money needed)

Simulate a **deposit**:
```bash
curl -s -X POST "http://localhost:8080/webhook/<your-secret>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"direction":"in","amount":"5","currency":"USDT","recipient_wallet":"TL5z...","sender_wallet":"Tabc","status":"confirmed"}}'
```
Simulate a **withdrawal**:
```bash
curl -s -X POST "http://localhost:8080/webhook/<your-secret>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"direction":"out","amount":"5","currency":"USDT","sender_wallet":"TL5z...","recipient_wallet":"Text","fee":"1","status":"confirmed"}}'
```
Each should return `{"result":"success"}` and deliver an email to `MAIL_TO`.
Then do one small **real** deposit to a `/topup` address to confirm the provider
actually calls your webhook.

---

## 6. HTTPS (if the provider requires it)

Many providers only accept `https://` webhooks. A raw `http://IP:8080` cert can't
be issued by Let's Encrypt, so you'd need a domain:

1. Point a (sub)domain's A record at `168.231.112.65`.
2. Install nginx + certbot; reverse-proxy `https://yourdomain/webhook/...` → `http://127.0.0.1:8080`.
3. Register `https://yourdomain/webhook/<secret>` with the provider, and close
   `8080` to the public (only nginx talks to it).

Ask me and I'll add the exact nginx + certbot config.

---

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Email notifications disabled` at startup | `SMTP_HOST` or `MAIL_TO` blank in `.env` |
| `SMTP verify failed` | Wrong host/port/credentials; Gmail needs an **App Password**, not the login password |
| Test curl works, real deposits don't | Webhook URL not registered with provider, or port `8080` blocked by firewall / provider needs HTTPS |
| `Cannot find package 'nodemailer'` | Ran without `npm install` after pulling — run it |
| Email lands in spam | Expected for Gmail server-mail; whitelist the sender, or use Brevo/SendGrid |
| No email but webhook logs the event | SMTP send failing — check `pm2 logs` for `sendTransactionEmail failed` |
