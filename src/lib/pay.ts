import type { ProvinceRules } from "./rules";
import type { Session } from "./hours";

export type WeekPay = {
  paidMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularPayCents: number;
  overtimePayCents: number;
  callInTopUpCents: number;
  grossCents: number;
  warnings: string[];
};

// Gross pay for one staff member for one work week (tips not included).
// This is an estimate for scheduling and payroll prep, not a payroll system:
// no deductions, vacation pay or stat holidays yet.
export function weekPay(sessions: Session[], rateCents: number, rules: ProvinceRules): WeekPay {
  const warnings: string[] = [];
  if (rateCents < rules.minWageCents) {
    warnings.push(`Hourly rate is below the ${rules.province} minimum wage`);
  }

  let paidMinutes = 0;
  let callInTopUp = 0;
  for (const s of sessions) {
    paidMinutes += s.paidMinutes;
    for (const f of s.flags) warnings.push(f);
    if (s.end === null) continue;

    if (s.longestStretchMinutes > rules.breakAfterMinutes) {
      warnings.push(
        `Worked ${(s.longestStretchMinutes / 60).toFixed(1)}h in a row without a ${rules.breakMinutes}-min break`,
      );
    }
    // Call-in rule: someone who reports for work gets at least N hours at minimum wage.
    if (s.paidMinutes > 0 && s.paidMinutes < rules.callInMinimumMinutes) {
      const owed = (rules.callInMinimumMinutes * rules.minWageCents) / 60;
      const earned = (s.paidMinutes * rateCents) / 60;
      callInTopUp += Math.max(0, owed - earned);
    }
  }

  const overtimeMinutes = Math.max(0, paidMinutes - rules.overtimeAfterMinutes);
  const regularMinutes = paidMinutes - overtimeMinutes;
  const regularPayCents = Math.round((regularMinutes * rateCents) / 60);
  const overtimePayCents = Math.round((overtimeMinutes * rateCents * rules.overtimeMultiplier) / 60);
  const callInTopUpCents = Math.round(callInTopUp);

  return {
    paidMinutes,
    regularMinutes,
    overtimeMinutes,
    regularPayCents,
    overtimePayCents,
    callInTopUpCents,
    grossCents: regularPayCents + overtimePayCents + callInTopUpCents,
    warnings,
  };
}
