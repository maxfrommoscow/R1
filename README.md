# GoSwift — 14 August slot monitor

Cloud monitor for a category **B car travelling from Estonia to Russia on 14 August 2026**. It checks both **Koidula** and **Luhamaa** every 60 seconds and sends an urgent push notification through [ntfy](https://ntfy.sh/) as soon as a cancelled slot appears.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxfrommoscow/R1)

Cloudflare's deployment screen asks for two private values:

- `NTFY_TOPIC` — the private notification topic supplied separately.
- `ADMIN_KEY` — the private control key supplied separately.

After deployment:

1. Install the ntfy app and subscribe to `https://ntfy.sh/<NTFY_TOPIC>`.
2. Start monitoring once by opening `https://<YOUR-WORKER>.workers.dev/start?key=<ADMIN_KEY>`.
3. Open the plain Worker URL at any time to see status and the most recent results.

Protected endpoints:

- `/start?key=<ADMIN_KEY>` — start the 60-second alarm loop.
- `/stop?key=<ADMIN_KEY>` — stop it.
- `/check?key=<ADMIN_KEY>` — run a check immediately.
- `/test-notification?key=<ADMIN_KEY>` — send a test push notification.

The monitor detects availability only. It does not enter driver or vehicle data, reserve, or pay for a slot.
