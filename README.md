# Dividends

A dividend portfolio tracker with a Liquid Glass look. People create an account, link Robinhood or another brokerage through Plaid, and see their own portfolio, updated every morning, on any device.

**Web app:** https://alexmaxham.github.io/Dividends-private/

- **Overview**: portfolio value and day change, forward annual income (also per month and per day), yield and yield on cost, dividends received this year compared with last year, this month's income, all-time totals, a 24-month income chart (12 months received, 12 projected), upcoming payouts, progress toward a monthly income goal, a full-year outlook, and value history.
- **Holdings**: a sortable, searchable table with value, gain, yield, yield on cost, annual income, weight and payment frequency. Click a holding for its detail: per-share payment history, next payments, dividend growth and how much it has paid you in total.
- **Dividends**: every payment, grouped by month and filterable by year, status and symbol, with CSV export. It also lists everything expected in the next 12 months.
- **Calendar**: the next 12 months of payouts, marked paid, confirmed, or estimated.
- **Insights**: income by year, allocation by sector and by holding (by income or by value), payment schedule mix, each holding's dividend growth over the last year, and a checkup that flags concentration, dividend cuts and very high yields.
- **Planner**: a compounding projection (DRIP on or off, contributions, dividend and price growth, tax) that shows when you'd reach your income goal.
- **Settings**: account (password, sign out, delete account), linked brokerages, income goal, dark/light theme, a glass slider from clear to frosted, privacy mode (hides every dollar amount), CSV import, and JSON backup and restore.

## How it works

| Part | Where it runs | What it does |
|---|---|---|
| Web app (`src/`) | GitHub Pages | The screens. Installable to the home screen and opens offline. |
| Sign-in | Firebase Authentication | Email and password accounts, with password reset. |
| Data | Cloud Firestore | Each person's settings, linked brokerages and portfolio, readable only by them (`firestore.rules`). |
| Plaid + daily sync (`functions/`) | Cloud Functions | Creates Plaid Link tokens, stores Plaid access tokens where no browser can read them, syncs each person's holdings and dividends every morning at 6:30 am Eastern, and deletes everything when someone deletes their account. |

People sign in to their brokerage on Plaid's and the brokerage's own screens, so the app never sees those passwords. Plaid gives read-only access to holdings and investment transactions; the app can't trade or move money. Plaid's secret lives in Google Secret Manager and is only used by Cloud Functions.

Without an account, anyone can look around with sample data. Until the Firebase config is filled in (step 6 below), the app skips sign-in and runs on its own in the browser.

## One-time setup

You can do all of this from a browser.

1. **Create the Firebase project.** At https://console.firebase.google.com, add a project (Google Analytics isn't needed). Then switch it to the **Blaze** pay-as-you-go plan (bottom left → Upgrade): Cloud Functions require it. At this size usage stays within the free allowance, but a card is required. Setting a budget alert at a few dollars is a good idea.
2. **Turn on sign-in.** Build → **Authentication** → Get started → Sign-in method → **Email/Password** → Enable. Then Authentication → Settings → **Authorized domains** → add `alexmaxham.github.io`.
3. **Create the database.** Build → **Firestore Database** → Create database → production mode, any US location. (The deploy in step 5 installs the security rules.)
4. **Give GitHub permission to deploy.** In https://console.cloud.google.com/iam-admin/serviceaccounts for the same project, create a service account named `github-deploy` with these roles: *Firebase Admin*, *Cloud Functions Admin*, *Cloud Scheduler Admin*, *Secret Manager Admin*, *Service Account User*, *Artifact Registry Administrator* and *Cloud Build Editor*. Open it → Keys → Add key → JSON, and download the file.
5. **Add the repository settings.** In this repo's Settings → Secrets and variables → Actions:
   - Variables tab: `FIREBASE_PROJECT_ID` = your project ID (shown in Firebase → Project settings).
   - Secrets tab: `FIREBASE_SERVICE_ACCOUNT` = the whole contents of the JSON key file; `PLAID_CLIENT_ID` and `PLAID_SECRET` = your keys from https://dashboard.plaid.com → Developers → Keys (the **Sandbox** secret to start).

   Then run **Actions → Deploy backend → Run workflow**. It tests the functions and rules, stores the Plaid keys in Secret Manager, and deploys.
6. **Connect the web app.** Firebase → Project settings → General → Your apps → add a **Web** app, and copy its `firebaseConfig` values into `src/cloud/config.ts`. Commit to `main`; GitHub Pages redeploys and the app now shows the sign-in screen.

In the Plaid sandbox, link any institution with `user_good` / `pass_good` to get Plaid's test brokerage accounts.

### Going live with real brokerages

1. In the Plaid dashboard, request **Production** access with the **Investments** product. Plaid reviews the app and asks some security questions. Plaid charges for Investments in production; check the dashboard for pricing.
2. Change `PLAID_ENV=sandbox` to `PLAID_ENV=production` in `functions/.env`, replace the `PLAID_SECRET` repository secret with the production secret, and run **Deploy backend** again. Links made in the sandbox don't carry over, so people link again.
3. Optional: for OAuth brokerages on phone browsers, register an https redirect URI (a page of this app) in Plaid and set `PLAID_REDIRECT_URI` in `functions/.env`.

## Data and privacy

- `users/{uid}`: the person's settings, the list of linked brokerages (names only) and sync status.
- `users/{uid}/portfolio/current`: holdings, dividends, value history. Written by Cloud Functions for linked accounts; people can edit their own only while no brokerage is linked (manual entry and CSV import).
- `plaidItems/{itemId}`: Plaid access tokens. The security rules block all access from the app; only Cloud Functions read them.
- **Unlink** revokes Plaid's access immediately. **Delete account** revokes every link at Plaid, erases all of the person's documents and deletes their sign-in.

## How the numbers work

- **Forward income**: the latest per-share payment × payments per year × shares. The frequency comes from the gaps between recent payments, or from the reported yield when there's only one payment.
- **Per-share rates**: Plaid reports the dollar amount of each dividend, not the rate, so the app works out each payment's share count from your buys and sells and divides.
- **History**: Plaid returns 24 months of transactions. Each sync keeps what earlier syncs saw, so history keeps growing past that.
- **Upcoming payouts**: estimates that continue each holding's schedule at the current rate and share count. (Plaid doesn't report announced dividends.)
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
