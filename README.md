# Dividends

A dividend portfolio tracker with a Liquid Glass look. It connects to Robinhood, refreshes once a day, and shows:

- **Overview**: portfolio value and day change, forward annual income (also per month and per day), yield and yield on cost, dividends received this year compared with last year, this month's income, all-time totals, a 24-month income chart (12 months received, 12 projected), upcoming payouts, progress toward a monthly income goal, a full-year outlook, and value history.
- **Holdings**: a sortable, searchable table with value, gain, yield, yield on cost, annual income, weight and payment frequency. Click a holding for its detail: per-share payment history, next payments, dividend growth and how much it has paid you in total.
- **Dividends**: every payment, grouped by month and filterable by year, status and symbol, with CSV export. It also lists everything expected in the next 12 months.
- **Calendar**: the next 12 months of payouts, marked paid, confirmed by Robinhood, or estimated.
- **Insights**: income by year, allocation by sector and by holding (by income or by value), payment schedule mix, each holding's dividend growth over the last year, and a checkup that flags concentration, dividend cuts and very high yields.
- **Planner**: a compounding projection (DRIP on or off, contributions, dividend and price growth, tax) that shows when you'd reach your income goal.
- **Settings**: Robinhood connection and the daily sync time, income goal, dark/light theme, a glass slider from clear to frosted, privacy mode (hides every dollar amount), CSV import, and JSON backup and restore.

## Run it with Robinhood

Robinhood sign-in and the daily update run on a small server you host yourself. It uses only Python's standard library and also serves the web app.

```bash
cd dividends
npm install
npm run build
python3 server/server.py        # http://127.0.0.1:8787
```

Open the page, go to **Settings → Connect Robinhood**, and sign in. Robinhood may ask for a code from your authenticator app, a code sent by text or email, or an approval in the Robinhood app; the page handles each. After that the server:

- syncs holdings, quotes, yields, sectors and your full dividend history (paid and announced) every day at the time you choose (default 6:30 pm, after the market close), and catches up if it was off at that time,
- records a daily value snapshot for the value chart,
- refreshes Robinhood's session token on its own, so you sign in again only if Robinhood ends the session.

The open page re-checks the server every 10 minutes and whenever you come back to the tab. **Sync now** updates on demand.

### Keep it running

- **Docker**: `docker build -t dividends . && docker run -d --restart unless-stopped -p 8787:8787 -v dividends-data:/app/data -e TZ=America/New_York -e APP_TOKEN=pick-a-long-secret dividends`
- **Without Docker**: run `python3 server/server.py` from a login item, a systemd service or launchd, on any always-on machine (a Raspberry Pi works).

Settings (environment variables):

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to open it from your phone on the same network. |
| `APP_TOKEN` | none | Required for every API call when set. **Set it whenever `HOST` isn't localhost**, then enter it in Settings. |
| `DATA_DIR` | `dividends/data` | Holds the Robinhood session (`session.json`, readable by its owner only) and the synced portfolio. |
| `TZ` | machine's | The time zone the daily sync time is read in. |

### Security and caveats

- Your password goes from the page to your server, then to Robinhood, and is never written to disk. The server stores only Robinhood's session token, in `data/session.json` with mode 600. **Disconnect** revokes it.
- Everything is read-only: nothing places orders or moves money.
- Robinhood has no official API for brokerage accounts. This uses the same private endpoints as Robinhood's website (the ones the open-source robin_stocks project documents), so a change on Robinhood's side can break sign-in or sync until the code is updated. It isn't affiliated with or endorsed by Robinhood.
- Don't expose the server to the internet without `APP_TOKEN` and HTTPS (for example, behind Tailscale or a reverse proxy).

## Without the server

When the page isn't served by the sync server (for example the GitHub Pages copy at `/Claude/dividends/`), it runs on its own and saves to this browser:

- It starts with a **sample portfolio** so you can look around.
- **Import CSV** takes Robinhood's account activity report (Account → Reports and statements; rows coded `CDIV` become dividends) or a holdings list with `Symbol`, `Shares`, `Average Cost` and `Price` columns.
- You can add and edit holdings and log dividends by hand. Prices don't update in this mode.

## How the numbers work

- **Forward income**: the latest per-share payment × payments per year × shares. The frequency comes from the gaps between recent payments, or from the reported yield when there's only one payment. Holdings with no payment history fall back to Robinhood's reported yield.
- **Upcoming payouts**: announced (pending) dividends from Robinhood, then estimates that continue each holding's schedule at the current rate and share count.
- **Dividend growth**: the latest per-share payment compared with the one about a year earlier.

## Develop

```bash
npm run server   # API on :8787
npm run dev      # Vite on :5173, proxies /api to the server
npm test         # web logic (Vitest) + server (unittest, against a fake Robinhood)
```
