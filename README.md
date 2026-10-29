# AI Caller

Calls the businesses in your spreadsheet with a realistic AI voice. The AI pitches the website redesign you made for them, sends the preview link by email or text while they're on the phone, handles objections, and logs the result. You decide who gets called and when, from a password-protected dashboard on your own domain.

```
Your sheet (.xlsx/.csv) ──► Dashboard (your domain) ──► "Call" ──► Twilio phone call
                                        ▲                              │
                                        │                     AI voice (OpenAI Realtime
                         transcript, summary, outcome          or ElevenLabs Agents)
                                        │                              │
                                        └──── sends preview link by email/SMS mid-call
```

## What it does

- **Import your sheet.** Columns are detected automatically: business name, phone, owner/contact, email, current website, redesign/demo link, category (dental, med spa…), city, timezone, notes/details. Other columns are kept too. Uploading again updates businesses by phone number.
- **Call when you say so.** Use "Call" on one business, or tick several and use "Call selected". Queued calls go out one at a time, `CALL_SPACING_SECONDS` apart.
- **Personalized pitch.** Each call gets the business's name, category, city, current site and your notes. The script is in [`prompts/sales-agent.md`](prompts/sales-agent.md); edit it freely.
- **Closes on the call.** When they agree, the AI sends the preview link and your booking/payment links by email (or SMS) during the call.
- **Results.** Each call stores the transcript, a summary, the outcome (`link_sent`, `interested`, `callback`, `not_interested`, `voicemail`, `do_not_call`, `sold`), any follow-up time or email they gave, and a suggested next step.
- **Safety rails.** The AI says it is an AI. It only calls inside your calling hours in the business's timezone. It stops after `MAX_ATTEMPTS` tries. "Don't call me again" puts the business on the do-not-call list permanently. It hangs up on voicemail without leaving a message.

## Which voice AI? (cost per minute, late 2026, check current prices)

| | OpenAI Realtime (default) | ElevenLabs Agents |
|---|---|---|
| Subscription | None, pay as you go | Needs a paid plan (from about $6/mo) beyond 15 free minutes |
| Voice + AI per minute | about $0.10–0.25 with `gpt-realtime`, about $0.03–0.06 with `gpt-realtime-mini` | about $0.08 plus about $0.01 for the LLM |
| Twilio phone | about $0.014/min plus about $1.15/mo per number | same (the calls go through your Twilio number) |
| Voice realism | Very natural, speech-to-speech, fast at handling interruptions | Widest choice of very human voices (you can also clone your own) |
| Setup | Just API keys in `.env` | Build the agent in the ElevenLabs dashboard (steps below) |

Calls to small businesses are short. Most are unanswered or last under a minute, and a good conversation is 2 to 4 minutes. So 100 calls usually costs **about $3–15**. Switch providers any time with `VOICE_PROVIDER=openai|elevenlabs`; no other code changes.

## Setup

Three ways to host it. Pick one:
- **Cloudflare Workers**: free hosting, always on, your domain. See [Deploy on Cloudflare](#2c-deploy-on-cloudflare-free).
- **Your own computer**: free; it runs only while you're calling.
- **A VPS with Docker**: about $5/month.

### 1. Accounts you need
1. **Twilio**: buy a local phone number. Copy the Account SID, Auth Token and number.
2. **OpenAI**: create an API key at platform.openai.com and add credit. *(or ElevenLabs, see below)*
3. **Email (recommended)**: a free [Resend](https://resend.com) account (verify your domain there, then use `RESEND_API_KEY`), or an SMTP login (Node only; for Gmail use an [app password](https://support.google.com/accounts/answer/185833)).

### 2a. Run it on a server (any VPS with Docker: DigitalOcean, Hetzner, Lightsail…)
```bash
git clone <this repo> ai-caller && cd ai-caller
cp .env.example .env      # fill in your values
docker compose up -d --build
```
Point your domain's DNS **A record** (for example `calls.yourdomain.com`) to the server's IP. Caddy gets the HTTPS certificate automatically. Then open `https://calls.yourdomain.com` and log in with `ADMIN_PASSWORD`.

> HTTPS on a real domain is required: Twilio streams the call audio to `wss://<your domain>/media-stream/<call id>`.

Without Docker: Node 22.13 or newer, then `npm ci && npm start`, behind any reverse proxy that supports WebSockets.

### 2b. Or run it from your own computer (free)
No server needed; it only has to be running while you make calls. Cloudflare Tunnel (free) gives your computer a public HTTPS address that Twilio can reach.

1. Install [Node.js 22](https://nodejs.org) (LTS) and [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. In this folder: `npm ci`, then `cp .env.example .env` and fill it in.
3. Start a tunnel in one terminal:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   It prints an address like `https://random-words.trycloudflare.com`. Put it in `.env` as `PUBLIC_URL`.
4. Start the app in a second terminal: `npm run local`, then open `http://localhost:3000`.

The quick tunnel address changes every time you start `cloudflared`, so update `PUBLIC_URL` and restart the app each time. For a fixed address on your own domain (for example `calls.yourdomain.com`, with the domain on Cloudflare), create a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) once and use that instead. Your leads and call history stay on your computer in `data/`. Keep the computer awake while calls run.

### 2c. Deploy on Cloudflare (free)
This runs on the Workers **Free** plan: a Worker for the website and API, D1 for the database, and Durable Objects for live calls and the call queue. You only pay OpenAI and Twilio for the calls themselves.

You need [Node.js 22](https://nodejs.org) on your computer to deploy, plus a free Cloudflare account. Email has to use Resend here, because Workers can't use SMTP.

```bash
npm ci
npx wrangler login
npx wrangler d1 create ai-caller        # copy the database_id it prints into wrangler.jsonc
```
1. Edit the `vars` section of `wrangler.jsonc` with your settings: your name, company, price, links, `EMAIL_FROM`, `TWILIO_FROM_NUMBER`, calling hours.
2. Add the secrets. Each command asks for the value:
   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put TWILIO_ACCOUNT_SID
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put RESEND_API_KEY
   ```
   (For ElevenLabs instead: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `TOOL_SECRET`, and set `VOICE_PROVIDER` to `elevenlabs`.)
3. Deploy with `npm run cf:deploy`. You get a `https://ai-caller.<you>.workers.dev` address that works right away.
4. **Your domain** (optional): Cloudflare dashboard → Workers & Pages → ai-caller → Settings → Domains & Routes → add `calls.yourdomain.com`. The domain must be on Cloudflare. Then add `"PUBLIC_URL": "https://calls.yourdomain.com"` to `vars` and deploy again.

Free plan limits are far above what calling needs: 100,000 requests a day, and Durable Objects and D1 are included. To change the sales script, edit `prompts/sales-agent.md` and run `npm run cf:deploy` again. Cloudflare Pages alone can't run this, because it only serves static files. This setup uses Workers, which also serves the dashboard.

### 3. First test
Add yourself as a row in the sheet (with your own phone number), upload it, and press **Call**. Listen to how it pitches, then adjust `prompts/sales-agent.md` and `.env` (voice, price, links). On Docker, restart with `docker compose restart app`. Locally, the next call picks up the changes.

### Using ElevenLabs instead
1. ElevenLabs → Agents → **Phone Numbers** → import your Twilio number. Copy its ID to `ELEVENLABS_PHONE_NUMBER_ID`.
2. Create an agent:
   - **System prompt**: paste [`prompts/sales-agent.md`](prompts/sales-agent.md). Its `{{variables}}` are filled per call automatically.
   - **First message**: `Hi, this is {{agent_name}}, an AI assistant calling for {{your_name}} at {{your_company}} about the {{business_name}} website. Is this a good moment?`
   - **Voice**: pick one you like.
   - **Tools**: enable the system tool **End call**. Add two **Webhook** tools (POST, header `X-Tool-Secret: <TOOL_SECRET>`):
     - `send_demo_link` → `https://<domain>/tools/send-demo-link`. Body params: `lead_id` (dynamic variable `lead_id`), `email` (string, LLM), `contact_name` (string, LLM), `channel` (string, LLM: `email`/`sms`/`both`).
     - `mark_do_not_call` → `https://<domain>/tools/do-not-call`. Body params: `lead_id` (dynamic variable `lead_id`), `reason` (string, LLM).
   - **Analysis → Data collection**: `outcome` (string: one of link_sent, interested, sold, callback, gatekeeper, not_interested, wrong_number, do_not_call, voicemail), `meeting_time`, `email`, `decision_maker_name`, `next_step`.
3. Workspace settings → **Post-call webhook** → `https://<domain>/webhooks/elevenlabs`. Copy its secret to `ELEVENLABS_WEBHOOK_SECRET`.
4. Copy the agent ID and API key into `.env` and set `VOICE_PROVIDER=elevenlabs`.

## Calling the right way (read this)

This makes calls with an AI voice, and phone rules are strict about that. In the US, the FCC treats AI voices as "artificial voice" under the TCPA. Calling **cell phones** with one requires prior consent, and penalties are $500–$1,500 per call. Many small-business "business numbers" are really the owner's cell. To stay safe:

- Call **business landlines** listed publicly for the business. Remove numbers you know are mobile, and check numbers against the National Do Not Call Registry.
- Keep the AI disclosure in the prompt (it says it's an AI calling for you). Honor every "don't call", which the system does automatically.
- Keep the calling hours (default 9 to 5 weekdays, in the business's timezone).
- If you turn on `RECORD_CALLS`, some states (CA, FL, WA, PA…) need **everyone** on the call to agree to recording. Add that to the opening.
- Outside the US, rules differ (for example, the UK and EU are stricter). Check your country's rules, and talk to a lawyer before calling at volume.

## Project layout

```
src/core/             all calling logic, shared by both versions
  leads.js            sheet columns → leads, phone numbers, calling hours
  agent.js            AI tools, outcomes, follow-up message
  actions.js          placing calls, mid-call tools, results, ElevenLabs webhook
  bridge.js           Twilio phone audio <-> OpenAI Realtime voice
  api.js              dashboard API
  store.js            database queries (SQLite on Node, D1 on Cloudflare)
src/server.js         Node server (Docker / VPS / your computer)
worker/index.js       Cloudflare Worker + Durable Objects
wrangler.jsonc        Cloudflare settings
prompts/sales-agent.md  the sales script (edit this!)
public/index.html     dashboard (reads your Excel file in the browser)
```
