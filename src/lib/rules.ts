// Province labour rules. Every number the pay engine uses lives here, so a
// rule change (or a new province like Quebec) is a config edit, not a rewrite.
//
// Nova Scotia source: Labour Standards Code and the Minimum Wage Order.
// Re-check novascotia.ca/lae/employmentrights before each pilot; the minimum
// wage changes most years (usually April 1 and/or October 1).

export type ProvinceRules = {
  province: string;
  minWageCents: number; // general minimum wage, per hour
  overtimeAfterMinutes: number; // per work week
  overtimeMultiplier: number; // applied to the employee's regular rate
  breakAfterMinutes: number; // no more than this many minutes in a row without a break
  breakMinutes: number; // length of the required break
  callInMinimumMinutes: number; // minimum paid time when someone reports for work
};

export const NOVA_SCOTIA: ProvinceRules = {
  province: "NS",
  minWageCents: 1700,
  overtimeAfterMinutes: 48 * 60,
  overtimeMultiplier: 1.5,
  breakAfterMinutes: 5 * 60,
  breakMinutes: 30,
  callInMinimumMinutes: 3 * 60,
};

export function rulesFor(province: string): ProvinceRules {
  if (province === "NS") return NOVA_SCOTIA;
  throw new Error(`No labour rules configured for province ${province}`);
}
