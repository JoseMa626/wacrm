# WhatsApp simulator (`tools/wa-sim`)

A stand-in for the WhatsApp Cloud API so you can use and demo the whole CRM —
inbox, automations, flows, pipelines, broadcasts, templates — **without a Meta
account**. wacrm talks to the simulator exactly as it talks to Meta, and the
simulator serves a web page that plays the customer's phone.

```
wacrm ──(Graph API calls, Bearer token)──▶ wa-sim  ◀── customer page (browser)
wacrm ◀──(signed webhooks: messages, statuses)── wa-sim
```

Nothing reaches a real phone. Use it for development, learning and demos; switch
back to Meta for real customers.

## What it supports

| wacrm feature | Simulator behaviour |
|---|---|
| Settings → WhatsApp (verify, health, subscribe, phone list, register) | Always succeeds with the configured fake ids |
| Text, media (link), reactions, read receipts / typing | Stored in the customer's chat; `sent` → `delivered` statuses, `read` when the chat is opened |
| Interactive buttons and lists | Rendered as tappable buttons / list sheet; taps send `button_reply` / `list_reply` |
| Templates (create, edit, delete, sync, send) | New templates are `APPROVED` immediately (a name containing `reject` becomes `REJECTED`); `hello_world` is pre-seeded; sends are rendered with their parameters; quick-reply buttons are tappable |
| Media uploads (template image headers) | Resumable upload stored in the simulator, served back with the token |

Not simulated: the 24-hour customer-service window, messaging tiers, pricing,
phone number quality changes, and customers sending media.

## Run locally

```bash
cd tools/wa-sim
SIM_ACCESS_TOKEN=sim-token SIM_APP_SECRET=sim-secret \
WACRM_WEBHOOK_URL=http://localhost:3000/api/whatsapp/webhook \
SIM_UI_USER=demo SIM_UI_PASSWORD=demo npm start      # http://localhost:3001
npm test
```

Then in wacrm's `.env.local`:

```bash
META_GRAPH_BASE_URL=http://localhost:3001/v21.0
META_APP_SECRET=your-real-secret,sim-secret   # the simulator signs with its own secret
```

Restart `npm run dev`, open **Settings → WhatsApp** and enter the simulator's
Phone Number ID (`SIM_PHONE_NUMBER_ID`, default `100000000000001`), WABA ID
(`SIM_WABA_ID`, default `200000000000001`) and access token (`SIM_ACCESS_TOKEN`).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SIM_ACCESS_TOKEN` | yes | Token wacrm must send (`Authorization: Bearer …`) |
| `SIM_APP_SECRET` | yes | Signs webhooks (`x-hub-signature-256`); add it to wacrm's `META_APP_SECRET` list |
| `WACRM_WEBHOOK_URL` | yes | wacrm's `/api/whatsapp/webhook` URL |
| `SIM_UI_USER`, `SIM_UI_PASSWORD` | yes | Basic auth for the customer page |
| `SIM_PHONE_NUMBER_ID`, `SIM_WABA_ID` | no | Fake ids (defaults above) |
| `SIM_DISPLAY_PHONE`, `SIM_VERIFIED_NAME` | no | Shown in Settings and on the page |
| `SIM_APP_ID` | no | Reported as the subscribed app; set it to wacrm's `META_APP_ID` to avoid the "app not subscribed" hint |
| `PUBLIC_BASE_URL` | no | Public URL used in paging/media links (default: request host) |
| `DATA_DIR` | no | State directory (default `./data`, `/app/data` in Docker) — mount a volume to keep chats |
| `PORT` | no | Default `3001` |

## Deploy (Docker / Coolify)

Build from this repo with base directory `tools/wa-sim` (it has its own
`Dockerfile`), expose port `3001`, mount a volume at `/app/data`, and set the
variables above. Point wacrm's `META_GRAPH_BASE_URL` at
`https://<simulator-domain>/v21.0` and redeploy wacrm.

## Switching back to Meta

1. Remove `META_GRAPH_BASE_URL` from wacrm and the simulator secret from
   `META_APP_SECRET`; redeploy.
2. Settings → WhatsApp: enter the real Phone Number ID, WABA ID and token.

Conversations created with simulated customers stay in the database; delete those
contacts if you don't want them mixed with real ones.
