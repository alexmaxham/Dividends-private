// Milestones: everyday bills your dividends cover, stacked up from the smallest. Typical US monthly costs.

export interface Milestone { id: string; label: string; cost: number; icon: string }

export const MILESTONES: Milestone[] = [
  { id: 'streaming', label: 'a streaming subscription', cost: 18, icon: 'tv' },
  { id: 'internet', label: 'your internet', cost: 70, icon: 'wifi' },
  { id: 'phone', label: 'your phone bill', cost: 90, icon: 'phone' },
  { id: 'insurance', label: 'car insurance', cost: 180, icon: 'car' },
  { id: 'utilities', label: 'your utilities', cost: 300, icon: 'bolt' },
  { id: 'groceries', label: 'your groceries', cost: 550, icon: 'cart' },
  { id: 'car', label: 'a car payment', cost: 750, icon: 'car' },
  { id: 'rent', label: 'rent', cost: 1700, icon: 'home' },
];

export interface MilestoneState extends Milestone {
  /** Monthly income needed to cover this bill and every smaller one. */
  total: number;
  covered: boolean;
}

export function milestones(monthlyIncome: number): { list: MilestoneState[]; next: MilestoneState | null; progress: number } {
  let total = 0;
  const list = MILESTONES.map((m) => {
    total += m.cost;
    return { ...m, total, covered: monthlyIncome >= total };
  });
  const nextIdx = list.findIndex((m) => !m.covered);
  const next = nextIdx >= 0 ? list[nextIdx] : null;
  const prevTotal = nextIdx > 0 ? list[nextIdx - 1].total : 0;
  return { list, next, progress: next ? Math.max(0, (monthlyIncome - prevTotal) / (next.total - prevTotal)) : 1 };
}
