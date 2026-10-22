// Account types for the planner: yearly contribution limits and how dividends are taxed inside each.
// Limits are the IRS figures for 2026; they usually rise each year, so the planner lets people edit them.

export const LIMITS_YEAR = 2026;

export type AccountType = 'taxable' | 'roth-ira' | 'traditional-ira' | '401k' | 'roth-401k' | 'hsa';
export type Tax = 'yearly' | 'deferred' | 'free';

export interface AccountInfo {
  label: string;
  tax: Tax;
  /** One line on how the account is taxed, shown under the picker. */
  note: string;
}

export const ACCOUNTS: Record<AccountType, AccountInfo> = {
  taxable: { label: 'Taxable brokerage', tax: 'yearly', note: 'No contribution limit. Dividends are taxed each year.' },
  'roth-ira': { label: 'Roth IRA', tax: 'free', note: 'Dividends grow tax-free, and qualified withdrawals are tax-free. Eligibility phases out at higher incomes.' },
  'traditional-ira': { label: 'Traditional IRA', tax: 'deferred', note: 'No tax on dividends while invested; withdrawals are taxed as income.' },
  '401k': { label: '401(k) / 403(b)', tax: 'deferred', note: 'Your own contributions only (employer match is extra). Withdrawals are taxed as income.' },
  'roth-401k': { label: 'Roth 401(k)', tax: 'free', note: 'Shares the 401(k) limit. Qualified withdrawals are tax-free.' },
  hsa: { label: 'HSA', tax: 'free', note: 'Tax-free when spent on qualified medical costs. Needs a high-deductible health plan.' },
};

/** The IRS yearly limit for this account at this age, including catch-up contributions. */
export function contributionLimit(type: AccountType, age: number, hsaFamily = false): number | null {
  switch (type) {
    case 'taxable':
      return null;
    case 'roth-ira':
    case 'traditional-ira':
      return 7500 + (age >= 50 ? 1100 : 0);
    case '401k':
    case 'roth-401k':
      // Ages 60–63 get a larger "super catch-up" than other workers 50 and over.
      return 24500 + (age >= 60 && age <= 63 ? 11250 : age >= 50 ? 8000 : 0);
    case 'hsa':
      return (hsaFamily ? 8750 : 4400) + (age >= 55 ? 1000 : 0);
  }
}
