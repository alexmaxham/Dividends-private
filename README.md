# Dividends

A dividend portfolio tracker with a Liquid Glass look. It links Robinhood through Plaid, refreshes once a day, and shows:

- **Overview**: portfolio value and day change, forward annual income (also per month and per day), yield and yield on cost, dividends received this year compared with last year, this month's income, all-time totals, a 24-month income chart (12 months received, 12 projected), upcoming payouts, progress toward a monthly income goal, a full-year outlook, and value history.
- **Holdings**: a sortable, searchable table with value, gain, yield, yield on cost, annual income, weight and payment frequency. Click a holding for its detail: per-share payment history, next payments, dividend growth and how much it has paid you in total.
- **Dividends**: every payment, grouped by month and filterable by year, status and symbol, with CSV export. It also lists everything expected in the next 12 months.
- **Calendar**: the next 12 months of payouts, marked paid, confirmed by Robinhood, or estimated.
- **Insights**: income by year, allocation by sector and by holding (by income or by value), payment schedule mix, each holding's dividend growth over the last year, and a checkup that flags concentration, dividend cuts and very high yields.
- **Planner**: a compounding projection (DRIP on or off, contributions, dividend and price growth, tax) that shows when you'd reach your income goal.
- **Settings**: linked accounts and the daily sync time, income goal, dark/light theme, a glass slider from clear to frosted, privacy mode (hides every dollar amount), CSV import, and JSON backup and restore.

## Connect Robinhood (through Plaid)

Accounts connect with [Plaid](https://plaid.com), the service behind most finance apps. You sign in to Robinhood on Plaid's and Robinhood's own screens; this app never sees your password. It gets read-only access to holdings and investment transactions, can't trade or move money, and you can unlink at any time (in Settings or at my.plaid.com). Plaid also works with most other US brokerages, so you can link several and see them together.

Linking and the daily update run on a small server you host yourself. It uses only Python's standard library and also serves the web app.

1. Create a free account at https://dashboard.plaid.com. Under **Developers → Keys**, copy your client ID and the **Sandbox** secret.
2. Build and start:
   ```bash
   cd dividends
   npm install && npm run build
   PLAID_CLIENT_ID=your-id PLAID_SECRET=your-sandbox-secret python3 server/server.py   # http://127.0.0.1:8787
   ```
3. Open the page, go to **Settings → Link Robinhood with Plaid**, and pick a bank. In the sandbox, sign in with `user_good` / `pass_good` to get Plaid's test investment accounts.
4. For your real Robinhood account, request **Production** access in the Plaid dashboard with the **Investments** product enabled. Then restart with `PLAID_ENV=production` and the production secret, and link again. Plaid charges for Investments in production; check the dashboard for current pricing.

Once linked, the server:

- syncs holdings, prices, cost basis, sectors and up to 24 months of dividends every day at the time you choose (default 6:30 pm), catches up if it was off, and keeps older dividends from earlier syncs, so history keeps growing past 24 months,
- records a daily value snapshot for the value chart and uses yesterday's price for the day's change,
- flags an account with **Reconnect** if Robinhood asks you to sign in again, which reopens Plaid to fix it.

Plaid doesn't report announced (future) dividends or per-share rates. The app works out each payment's share count from your buys and sells, and the calendar estimates upcoming payments from each holding's schedule.

The open page re-checks the server every 10 minutes and whenever you come back to the tab. **Sync now** updates on demand.

### Keep it running

- **Docker**: `docker build -t dividends . && docker run -d --restart unless-stopped -p 8787:8787 -v dividends-data:/app/data -e TZ=America/New_York -e PLAID_CLIENT_ID=… -e PLAID_SECRET=… -e PLAID_ENV=production -e APP_TOKEN=pick-a-long-secret dividends`
- **Without Docker**: run the server from a login item, a systemd service or launchd, on any always-on machine (a Raspberry Pi works).

Settings (environment variables):

| Variable | Default | |
|---|---|---|
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | none | From the Plaid dashboard. Without them the server falls back to direct Robinhood sign-in (below). |
| `PLAID_ENV` | `sandbox` | `production` for real accounts. |
| `PLAID_REDIRECT_URI` | none | Only needed for OAuth sign-in on phone browsers: an https URL that serves this app, registered in the Plaid dashboard. |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to open it from your phone on the same network. |
| `APP_TOKEN` | none | Required for every API call when set. **Set it whenever `HOST` isn't localhost**, then enter it in Settings. |
| `DATA_DIR` | `dividends/data` | Holds Plaid access tokens (`plaid.json`, readable by its owner only) and the synced portfolio. |
| `TZ` | machine's | The time zone the daily sync time is read in. |

### Security

- Your Robinhood password goes only to Plaid and Robinhood. The server stores Plaid access tokens in `data/plaid.json` with mode 600 and never sends them to the browser. **Unlink** revokes them at Plaid.
- Don't expose the server to the internet without `APP_TOKEN` and HTTPS (for example, behind Tailscale or a reverse proxy).

### Fallback: direct Robinhood sign-in

If the server starts without Plaid keys, **Connect Robinhood** signs in to Robinhood directly: you enter your email and password in the page (they go to your server, then Robinhood, and aren't saved). This uses Robinhood's private website API (the one the open-source robin_stocks project documents), so it can break when Robinhood changes it, and it isn't affiliated with Robinhood. Plaid is the recommended way.

## Without the server

When the page isn't served by the sync server (for example the GitHub Pages copy at `/Claude/dividends/`), it runs on its own and saves to this browser:

- It starts with a **sample portfolio** so you can look around.
- **Import CSV** takes Robinhood's account activity report (Account → Reports and statements; rows coded `CDIV` become dividends) or a holdings list with `Symbol`, `Shares`, `Average Cost` and `Price` columns.
- You can add and edit holdings and log dividends by hand. Prices don't update in this mode.

## How the numbers work

- **Forward income**: the latest per-share payment × payments per year × shares. The frequency comes from the gaps between recent payments, or from the reported yield when there's only one payment. Holdings with no payment history fall back to Robinhood's reported yield.
- **Upcoming payouts**: announced dividends when the connection reports them (direct Robinhood sign-in does; Plaid doesn't), then estimates that continue each holding's schedule at the current rate and share count.
- **Dividend growth**: the latest per-share payment compared with the one about a year earlier.

## Develop

```bash
npm run server   # API on :8787
npm run dev      # Vite on :5173, proxies /api to the server
npm test         # web logic (Vitest) + server (unittest, against fake Plaid and Robinhood APIs)
```
