// Splits a tip pool by hours worked. Works in whole cents and hands leftover
// cents to the people with the largest remainders, so the shares always add
// up to the exact pool. Nobody "loses a penny" to rounding.

export type TipShare = { staffId: string; minutes: number; amountCents: number };

export function splitTips(poolCents: number, workers: { staffId: string; minutes: number }[]): TipShare[] {
  const eligible = workers.filter((w) => w.minutes > 0);
  const totalMinutes = eligible.reduce((t, w) => t + w.minutes, 0);
  if (poolCents <= 0 || totalMinutes === 0) {
    return workers.map((w) => ({ ...w, amountCents: 0 }));
  }

  const raw = eligible.map((w) => {
    const exact = (poolCents * w.minutes) / totalMinutes;
    return { ...w, amountCents: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = poolCents - raw.reduce((t, r) => t + r.amountCents, 0);
  const order = [...raw].sort((a, b) => b.rem - a.rem || a.staffId.localeCompare(b.staffId));
  for (const r of order) {
    if (left <= 0) break;
    r.amountCents += 1;
    left -= 1;
  }

  const byId = new Map(raw.map((r) => [r.staffId, r.amountCents]));
  return workers.map((w) => ({ ...w, amountCents: byId.get(w.staffId) ?? 0 }));
}
