# AI Caller: notes for Claude

AI cold-calling system for Fardin (Rizer Web): imports a sheet of local businesses, calls them with an AI voice
(OpenAI Realtime through Twilio), pitches the redesigned website Fardin already built for them, and closes.
README.md is the user guide; this file is for working on the code.

## Commands
- `npm test`: the whole suite (node:test) against fake Twilio, OpenAI, Cal.com and email. Run it after every change.
- `npm run dev`: Node server with auto-reload on http://localhost:3000 (reads `.env`; copy `.env.example`).
- `npx wrangler dev`: the Cloudflare version locally (D1 + Durable Objects). `npx wrangler deploy --dry-run` checks the build.
- Needs Node 22+ (uses `node:sqlite`).

## Architecture rules
- All logic lives in `src/core/*` and must stay platform-free (no Node or Cloudflare APIs; use `fetch`, WebCrypto).
  `src/server.js` (Express + ws + node:sqlite) and `worker/index.js` (Worker + D1 + Durable Objects `CallSession`
  and `Dialer`) are thin adapters. Every feature must work on both.
- Database access only through `createStore()` in `src/core/store.js`. Schema changes = a new entry at the end of
  `MIGRATIONS` in `src/core/schema.js` (never edit a released one).
- Settings: listed and validated in `src/core/settings.js`; values saved in the dashboard override env vars;
  `buildConfig()` in `src/core/config.js` turns them into `ctx.config`.
- Cloudflare free plan limits: about 50 database queries per request, 100 bound parameters per query (use
  `json_each(?)` for id lists), Twilio webhooks must answer within 15 s (use `inBackground(ctx, promise)`).
- Times: SQLite `datetime('now')` gives `YYYY-MM-DD HH:MM:SS` (UTC); JS gives ISO strings. Don't compare the two
  formats as strings without converting. Calling hours are always in the business's own timezone (`leadTimezone`).

## How a call works
`placeCall` (actions.js) → Twilio call with `<Connect><Stream>` → `/media-stream/:callId` → `CallBridge`
(bridge.js) connects to OpenAI Realtime, sends the prompt from `renderPrompt` (agent.js) and tools, handles
barge-in, marks, voicemail detection, dead air, transfer to Fardin, phone-menu key presses (`resume=keys`),
call-back booking and Cal.com booking → on hang-up `analyzeCall` + `recordCallResult` (exactly once per call).
The queue (queue.js, `runDue`) places one call at a time from `queue_items`.

## Things that must never change
- The AI always says it is an AI (locked "# Always" section in `renderPrompt`); it never claims to be human.
- Never commit API keys or passwords. Fardin pastes keys into the dashboard Settings himself.
- Business facts (price $750, lowest $650, pay only after the site is live, clients, etc.) live in the
  `KB_*` settings (`wrangler.jsonc` vars / Settings → "What the AI knows"), not in code.

## Known gaps / next steps
- Never tested on a real phone call yet: do the checklist in README "First test" (call yourself, a voicemail,
  a transfer, calling the Twilio number back, a Cal.com booking).
- `public/index.html` loads SheetJS from cdn.sheetjs.com without an integrity hash.
- Twilio voicemail detection can mistake some phone menus for answering machines.
- Results "by day" groups calls by UTC date (`date(c.created_at)` in `store.analytics`), so late-evening US calls show on the next day.
- Cloudflare housekeeping is near the 50-queries-per-run limit of the free plan; keep new work out of it or split it.
