# Dividends

A dividend portfolio tracker with a Liquid Glass look. People create an account, link Robinhood or another brokerage through Plaid, and see their own portfolio, updated every morning, on any device.

**Web app:** https://alexmaxham.github.io/Dividends-private/

- **Overview**: portfolio value and day change (prices refresh during market hours), forward annual income (also per month and per day), yield and yield on cost, dividends received this year compared with last year, this month's income, all-time totals, a 24-month income chart (12 months received, 12 projected), upcoming payouts, progress toward a monthly income goal, milestones (the everyday bills your dividends now cover), a full-year outlook, ex-dividend dates in the next three weeks with the day to buy by, and value history.
- **Accounts**: with more than one brokerage account (individual, Roth IRA, …), a picker beside each page title shows one at a time.
- **Holdings**: a sortable, searchable table with value, gain, yield, yield on cost, annual income, weight and payment frequency. Click a holding for its detail: per-share payment history, next payments with ex-dividend dates, shares per account, dividend growth and how much it has paid you in total.
- **Dividends**: every payment, grouped by month and filterable by year, status and symbol, with CSV export. It also lists everything expected in the next 12 months.
- **Calendar**: the next 12 months of payouts, marked paid, confirmed (declared by the company, with its ex-dividend date) or estimated.
- **Insights**: income by year, a year in review you can download or share, allocation by sector, holding and account (by income or by value), total return compared with SPY or SCHD (dividends included), payment schedule mix, each holding's dividend growth over the last year, and a checkup that flags concentration, dividend cuts and very high yields.
- **Planner**: a compounding projection (DRIP on or off, contributions, dividend and price growth, tax, account type and its contribution limit) that shows when you'd reach your income goal. It can start from one of your linked accounts.
- **Watchlist**: look up any symbol for its price, yield, payment schedule, dividend growth and next ex-dividend date, and see what adding money to it would do to your yearly income and payout calendar.
- **Taxes**: each year's dividends in taxable accounts split into qualified and ordinary, an estimated federal tax bill, a preview of each brokerage's 1099-DIV, and a CSV.
- **Notifications**: by email or push, for payments ("KO paid you $21.20"), dividend raises and cuts as they're announced, a brokerage that needs reconnecting, and a Sunday summary.
- **Settings**: account (password, Google sign-in, two-step verification with an authenticator app, sign out, delete account), linked brokerages, notifications, income goal and tax rates, dark/light theme, a glass slider from clear to frosted, privacy mode (hides every dollar amount), CSV import, and JSON backup and restore.

## How it works

| Part | Where it runs | What it does |
|---|---|---|
| Web app (`src/`) | GitHub Pages | The screens. Installable to the home screen and opens offline. |
| Sign-in | Firebase Authentication | Email and password accounts, with password reset. |
| Data | Cloud Firestore | Each person's settings, linked brokerages and portfolio, readable only by them (`firestore.rules`). |
| Plaid + daily sync (`functions/`) | Cloud Functions | Creates Plaid Link tokens, stores Plaid access tokens where no browser can read them, syncs each person's holdings and dividends every morning at 6:30 am Eastern, and deletes everything when someone deletes their account. |
| Market data (`functions/src/market*.ts`) | Cloud Functions | Every two hours, keeps announced dividends, ex-dividend dates, splits, closing prices and benchmark history for every held or watched symbol, from [Massive](https://massive.com) (formerly Polygon.io). Prices during the day come from [Finnhub](https://finnhub.io). Optional. |
| Notifications (`functions/src/notify.ts`) | Cloud Functions | After each daily sync, and Sunday evenings: email through [Resend](https://resend.com) and web push. Optional. |

People sign in to their brokerage on Plaid's and the brokerage's own screens, so the app never sees those passwords. Plaid gives read-only access to holdings and investment transactions; the app can't trade or move money. Plaid's secret lives in Google Secret Manager and is only used by Cloud Functions.

Without an account, anyone can look around with sample data. Until the Firebase config is filled in (step 6 below), the app skips sign-in and runs on its own in the browser.

## One-time setup

You can do all of this from a browser.

1. **Create the Firebase project.** At https://console.firebase.google.com, add a project (Google Analytics isn't needed). Then switch it to the **Blaze** pay-as-you-go plan (bottom left → Upgrade): Cloud Functions require it. At this size usage stays within the free allowance, but a card is required. Setting a budget alert at a few dollars is a good idea.
2. **Turn on sign-in.** Build → **Authentication** → Get started → Sign-in method → **Email/Password** → Enable. Then Authentication → Settings → **Authorized domains** → add `alexmaxham.github.io`.
3. **Create the database.** Build → **Firestore Database** → Create database → production mode, any US location. (The deploy in step 5 installs the security rules.)
4. **Give GitHub permission to deploy.** In https://console.cloud.google.com/iam-admin/serviceaccounts for the same project, create a service account named `github-deploy` with these roles: *Firebase Admin*, *Cloud Functions Admin*, *Cloud Scheduler Admin*, *Secret Manager Admin*, *Service Account User*, *Artifact Registry Administrator*, *Cloud Build Editor*, *Cloud Run Admin* and *Service Usage Admin*. Open it → Keys → Add key → JSON, and download the file.
5. **Add the repository settings.** In this repo's Settings → Secrets and variables → Actions:
   - Variables tab: `FIREBASE_PROJECT_ID` = your project ID (shown in Firebase → Project settings).
   - Secrets tab: `FIREBASE_SERVICE_ACCOUNT` = the whole contents of the JSON key file; `PLAID_CLIENT_ID` and `PLAID_SECRET` = your keys from https://dashboard.plaid.com → Developers → Keys (the **Sandbox** secret to start).

   Then run **Actions → Deploy backend → Run workflow**. It tests the functions and rules, stores the Plaid keys in Secret Manager, and deploys.
6. **Connect the web app.** Firebase → Project settings → General → Your apps → add a **Web** app, and copy its `firebaseConfig` values into `src/cloud/config.ts`. Commit to `main`; GitHub Pages redeploys and the app now shows the sign-in screen.

In the Plaid sandbox, link any institution with `user_good` / `pass_good` to get Plaid's test brokerage accounts.

### Optional features

Each of these is off until its key is added, and the app works without them. Add keys under the repository's Settings → Secrets and variables → Actions, then run **Actions → Deploy backend** again.

**Market data** (announced dividends, ex-dividend dates, yields for holdings that haven't paid you yet, split fixes, benchmark comparison, the watchlist):

1. Sign up at https://massive.com (formerly Polygon.io). The free **Basic** plan is enough: end-of-day data, two years of history, 5 calls a minute. The app works within that limit by fetching each day's announcements for all stocks in one go and sharing each symbol's data between everyone who holds it.
2. Add the API key as the secret `MARKET_API_KEY`.
3. For prices during the day, sign up at https://finnhub.io (free: 60 calls a minute) and add its key as `FINNHUB_API_KEY`. Without it, prices update once each morning.

On a paid Massive plan, raise `MARKET_CALLS_PER_MINUTE` in `functions/.env`.

**Email notifications:**

1. Sign up at https://resend.com and create an API key. Add it as the secret `RESEND_API_KEY`.
2. Until you verify a domain in Resend, it only delivers to your own address. To email other people, verify a domain you own (Resend → Domains) and add the repository variable `EMAIL_FROM`, for example `Dividends <alerts@yourdomain.com>`.

People get emails only once they've verified their email address.

**Push notifications:**

1. Make a key pair: `npx web-push generate-vapid-keys`.
2. Add the public key as the repository **variable** `VAPID_PUBLIC_KEY` and the private key as the **secret** `VAPID_PRIVATE_KEY`.

On iPhone and iPad, push works once the app is added to the Home Screen (Share → Add to Home Screen, iOS 16.4 or later).

**Google sign-in:** Firebase → Authentication → Sign-in method → Add new provider → **Google** → Enable (pick a support email) → Save. `alexmaxham.github.io` must be in the authorized domains (step 2 above). Google's sign-in opens in a pop-up window. If someone's browser blocks pop-ups, the app falls back to a full-page redirect, which some browsers (Safari especially) block for sites like this one whose sign-in pages live on another domain; allowing pop-ups fixes it.

**Two-step verification** with an authenticator app needs Firebase's Identity Platform upgrade (free for this size: Firebase → Authentication → Settings → upgrade), then TOTP turned on once. In Google Cloud Shell (https://shell.cloud.google.com) for the project:

```bash
curl -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$(gcloud config get-value project)/config?updateMask=mfa" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
  -H "X-Goog-User-Project: $(gcloud config get-value project)" \
  -d '{"mfa": {"providerConfigs": [{"state": "ENABLED", "totpProviderConfig": {"adjacentIntervals": 5}}]}}'
```

People can then turn it on in Settings → Account. It needs a verified email address.

### Going live with real brokerages

1. In the Plaid dashboard, request **Production** access with the **Investments** product. Plaid reviews the app and asks some security questions. Plaid charges for Investments in production; check the dashboard for pricing.
2. Change `PLAID_ENV=sandbox` to `PLAID_ENV=production` in `functions/.env`, replace the `PLAID_SECRET` repository secret with the production secret, and run **Deploy backend** again. Links made in the sandbox don't carry over, so people link again.
3. **Phone sign-in for OAuth brokerages.** Some brokerages sign people in on their own site or app; on phones, Plaid then sends them back to the app to finish. In the Plaid dashboard under **Developers → API → Allowed redirect URIs**, add `https://alexmaxham.github.io/Dividends-private/`. Then set `PLAID_REDIRECT_URI=https://alexmaxham.github.io/Dividends-private/` in `functions/.env` and deploy. (Set it only after registering it: Plaid rejects links with an unregistered redirect URI.)

The privacy policy Plaid asks for is at https://alexmaxham.github.io/Dividends-private/privacy.html (`public/privacy.html`).

## Data and privacy

- `users/{uid}`: the person's settings, the list of linked brokerages (names only) and sync status.
- `users/{uid}/portfolio/current`: holdings, dividends, value history. Written by Cloud Functions for linked accounts; people can edit their own only while no brokerage is linked (manual entry and CSV import).
- `plaidItems/{itemId}`: Plaid access tokens. The security rules block all access from the app; only Cloud Functions read them.
- `market/{SYMBOL}`: public market data (announced dividends, splits, prices), shared by everyone. Signed-in people can read it; only Cloud Functions write it. It holds nothing about any person.
- `pushSubs/{id}` and `notifyLog/{uid}`: where to deliver someone's push notifications, and which notifications were already sent. Only Cloud Functions read them.
- **Unlink** revokes Plaid's access immediately. **Delete account** revokes every link at Plaid, erases all of the person's documents and deletes their sign-in.

## How the numbers work

- **Forward income**: the latest per-share payment × payments per year × shares. With market data, that's the newest amount the company has declared (so a raise counts as soon as it's announced, and a holding that hasn't paid you yet still has income); otherwise it's your latest payment. The frequency comes from the announcement, the gaps between recent payments, or the reported yield when there's only one payment.
- **Per-share rates**: Plaid reports the dollar amount of each dividend, not the rate, so the app works out each payment's share count from your buys and sells and divides.
- **History**: Plaid returns 24 months of transactions. Each sync keeps what earlier syncs saw, so history keeps growing past that.
- **Upcoming payouts**: declared dividends are confirmed, with their ex-dividend date (from market data; Plaid doesn't report announced dividends). After those, estimates continue each holding's schedule at the current rate and share count.
- **Ex-dividend dates**: own the shares by the close of the trading day before the ex-dividend date to get the payment.
- **Splits**: the share count behind each past payment counts splits the brokerage reports. With market data, each payment's per-share amount is taken from the company's announcement, which also covers splits the brokerage didn't report.
- **Taxes**: dividends in taxable accounts only. Qualified or ordinary comes from the brokerage's label where Plaid has one; otherwise REITs, BDCs and bond or option-income funds count as ordinary and everything else as qualified. The estimate is federal only, less foreign tax withheld.
- **Total return**: time-weighted from the daily value history, so money you add or take out doesn't count as a gain; cash dividends count as return. The benchmark reinvests its dividends on each ex-dividend date.
- **Day change**: yesterday's synced price is kept as the previous close.
- **Dividend growth**: the latest per-share payment compared with the one about a year earlier.

## Without an account

When nobody is signed in, the app shows sample data. On a copy without Firebase configured it saves to the browser instead, and accepts:

- **Import CSV**: Robinhood's account activity report (Account → Reports and statements; rows coded `CDIV` become dividends), or a holdings list with `Symbol`, `Shares`, `Average Cost` and `Price` columns.
- Holdings and dividends added by hand.

## Develop

```bash
npm install && npm --prefix functions install
npm run dev              # web app on :5173
npm test                 # web app logic
npm run test:functions   # Plaid logic, plus Firestore rules and sync on the emulator (needs Java 21)
```

To run the whole app against local emulators:

```bash
cd functions && npx firebase emulators:start --only auth,firestore,functions --project demo-dividends
VITE_FIREBASE_EMULATORS=true npm run dev     # in another terminal
```
