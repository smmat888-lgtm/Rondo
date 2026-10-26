// Schedule rule checks. Runs before a week is published, and every time Rondo
// assigns someone automatically, so a schedule never goes out that breaks the
// province's rules without the manager seeing it first.
//
// Three levels:
//   block: cannot publish (overlapping shifts, scheduled on approved time off, pay below minimum wage)
//   warn:  can publish after the manager confirms (overtime, outside availability, 3-hour call-in cost, no weekly rest)
//   info:  Rondo handles it (breaks get planned automatically)

import type { ProvinceRules } from "./rules";
import { localParts, minutesBetween } from "./time";

export type PlanShift = { id?: string; staffId: string; role: string; startAt: string; endAt: string };
export type PlanStaff = { id: string; name: string; role: string; hourlyRateCents: number; maxWeekMinutes: number | null };
export type AvailabilityWindow = { staffId: string; dow: number; start: string; end: string };
export type TimeOff = { staffId: string; date: string };

export type Context = {
  rules: ProvinceRules;
  tz: string;
  weekFromUtc: string;
  weekToUtc: string;
  availability: AvailabilityWindow[];
  timeOff: TimeOff[];
};

export type Issue = {
  level: "block" | "warn" | "info";
  code: string;
  staffId: string | null;
  shiftId?: string;
  message: string;
  extraCostCents?: number;
};

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const ms = (iso: string) => Date.parse(iso);

// Paid time for a planned shift: the unpaid 30-minute break comes off shifts over 5 hours.
export function plannedPaidMinutes(startAt: string, endAt: string, rules: ProvinceRules): number {
  const len = minutesBetween(startAt, endAt);
  return len > rules.breakAfterMinutes ? len - rules.breakMinutes : len;
}

export function plannedCostCents(startAt: string, endAt: string, rateCents: number, rules: ProvinceRules): number {
  return Math.round((plannedPaidMinutes(startAt, endAt, rules) * rateCents) / 60);
}

// When the break should start so nobody works more than 5 hours in a row.
// Placed near the middle of the shift, on a quarter hour. Returns null for
// short shifts, and twoNeeded for shifts too long for one break to cover.
export function plannedBreak(startAt: string, endAt: string, rules: ProvinceRules): { startAt: string; twoNeeded: boolean } | null {
  const len = minutesBetween(startAt, endAt);
  if (len <= rules.breakAfterMinutes) return null;
  const offset = Math.min(rules.breakAfterMinutes, Math.floor((len - rules.breakMinutes) / 2 / 15) * 15);
  const after = len - offset - rules.breakMinutes;
  return { startAt: new Date(ms(startAt) + offset * 60000).toISOString(), twoNeeded: after > rules.breakAfterMinutes };
}

export function timeOf(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function when(iso: string, tz: string): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short" }).format(new Date(iso));
  return `${day} ${timeOf(iso, tz)}`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}h`;

export function isAvailable(staffId: string, startAt: string, endAt: string, ctx: Context): boolean {
  const windows = ctx.availability.filter((a) => a.staffId === staffId);
  if (windows.length === 0) return true;
  const { date, time } = localParts(startAt, ctx.tz);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const s = toMin(time);
  const e = s + minutesBetween(startAt, endAt);
  return windows.some((w) => {
    const ws = toMin(w.start);
    let we = toMin(w.end);
    if (we <= ws) we += 1440; // window runs past midnight ("00:00" to "00:00" is all day)
    if (w.dow === dow) return ws <= s && e <= we;
    // Yesterday's late window can cover a shift that starts after midnight.
    if (w.dow === (dow + 6) % 7) return ws - 1440 <= s && e <= we - 1440;
    return false;
  });
}

export function isOnTimeOff(staffId: string, startAt: string, ctx: Context): boolean {
  const date = localParts(startAt, ctx.tz).date;
  return ctx.timeOff.some((t) => t.staffId === staffId && t.date === date);
}

export function overlaps(a: { startAt: string; endAt: string }, b: { startAt: string; endAt: string }): boolean {
  return ms(a.startAt) < ms(b.endAt) && ms(b.startAt) < ms(a.endAt);
}

// Longest stretch with no shift inside the week, in minutes.
export function longestRestMinutes(shifts: { startAt: string; endAt: string }[], ctx: Context): number {
  const from = ms(ctx.weekFromUtc);
  const to = ms(ctx.weekToUtc);
  const sorted = [...shifts].sort((a, b) => ms(a.startAt) - ms(b.startAt));
  let longest = 0;
  let cursor = from;
  for (const s of sorted) {
    longest = Math.max(longest, ms(s.startAt) - cursor);
    cursor = Math.max(cursor, ms(s.endAt));
  }
  longest = Math.max(longest, to - cursor);
  return Math.floor(longest / 60000);
}

export function weekPaidMinutes(shifts: PlanShift[], staffId: string, rules: ProvinceRules): number {
  return shifts.filter((s) => s.staffId === staffId).reduce((t, s) => t + plannedPaidMinutes(s.startAt, s.endAt, rules), 0);
}

// Hard rules for putting someone on a shift automatically. Rondo never
// auto-assigns a shift that would cause overtime, go past someone's own weekly
// limit, ignore their availability or time off, or take away their weekly rest.
export function canAssign(staff: PlanStaff, shift: Omit<PlanShift, "staffId">, week: PlanShift[], ctx: Context): string[] {
  const reasons: string[] = [];
  if (staff.role !== shift.role) reasons.push(`Not a ${shift.role}`);
  if (isOnTimeOff(staff.id, shift.startAt, ctx)) reasons.push("Approved time off");
  if (!isAvailable(staff.id, shift.startAt, shift.endAt, ctx)) reasons.push("Outside availability");
  const theirs = week.filter((s) => s.staffId === staff.id);
  if (theirs.some((s) => overlaps(s, shift))) reasons.push("Already working then");
  const after = weekPaidMinutes(theirs, staff.id, ctx.rules) + plannedPaidMinutes(shift.startAt, shift.endAt, ctx.rules);
  if (after > ctx.rules.overtimeAfterMinutes) reasons.push("Would go into overtime");
  if (staff.maxWeekMinutes != null && after > staff.maxWeekMinutes) reasons.push(`Over their ${hours(staff.maxWeekMinutes)} weekly limit`);
  if (longestRestMinutes([...theirs, { ...shift }], ctx) < ctx.rules.weeklyRestMinutes) reasons.push("No 24 hours off that week");
  return reasons;
}

export function checkSchedule(shifts: PlanShift[], staff: PlanStaff[], ctx: Context): Issue[] {
  const { rules, tz } = ctx;
  const issues: Issue[] = [];
  const byId = new Map(staff.map((s) => [s.id, s]));
  let breaksPlanned = 0;

  for (const person of staff) {
    const theirs = shifts.filter((s) => s.staffId === person.id).sort((a, b) => ms(a.startAt) - ms(b.startAt));
    if (theirs.length === 0) continue;
    const name = person.name;

    if (person.hourlyRateCents < rules.minWageCents) {
      issues.push({
        level: "block",
        code: "below_min_wage",
        staffId: person.id,
        message: `${name}'s pay rate (${money(person.hourlyRateCents)}/h) is below the ${rules.province} minimum wage of ${money(rules.minWageCents)}/h.`,
      });
    }

    for (let i = 0; i < theirs.length; i++) {
      const s = theirs[i];
      const at = when(s.startAt, tz);
      const next = theirs[i + 1];
      for (let j = i + 1; j < theirs.length && ms(theirs[j].startAt) < ms(s.endAt); j++) {
        issues.push({ level: "block", code: "overlap", staffId: person.id, shiftId: theirs[j].id, message: `${name} has two shifts at the same time on ${at}.` });
      }
      if (isOnTimeOff(person.id, s.startAt, ctx)) {
        issues.push({ level: "block", code: "time_off", staffId: person.id, shiftId: s.id, message: `${name} has approved time off on ${at}.` });
      }
      if (!isAvailable(person.id, s.startAt, s.endAt, ctx)) {
        issues.push({ level: "warn", code: "availability", staffId: person.id, shiftId: s.id, message: `${name} isn't available for the ${at} shift.` });
      }
      const len = minutesBetween(s.startAt, s.endAt);
      if (len < rules.callInMinimumMinutes) {
        const owed = (rules.callInMinimumMinutes * rules.minWageCents) / 60;
        const extra = Math.round(Math.max(0, owed - (len * person.hourlyRateCents) / 60));
        if (extra > 0) {
          issues.push({
            level: "warn",
            code: "call_in",
            staffId: person.id,
            shiftId: s.id,
            extraCostCents: extra,
            message: `${name}'s ${at} shift is ${hours(len)}. The 3-hour minimum means paying about ${money(extra)} more than the hours worked.`,
          });
        }
      }
      const brk = plannedBreak(s.startAt, s.endAt, rules);
      if (brk) breaksPlanned++;
      if (brk?.twoNeeded) {
        issues.push({ level: "warn", code: "long_shift", staffId: person.id, shiftId: s.id, message: `${name}'s ${at} shift is ${hours(len)} and needs two breaks.` });
      }
      if (next && !overlaps(s, next)) {
        const gap = minutesBetween(s.endAt, next.startAt);
        if (gap < 8 * 60) {
          issues.push({
            level: "info",
            code: "clopen",
            staffId: person.id,
            shiftId: next.id,
            message: `${name} has only ${hours(gap)} between shifts before ${when(next.startAt, tz)}.`,
          });
        }
      }
    }

    const paid = weekPaidMinutes(theirs, person.id, rules);
    if (paid > rules.overtimeAfterMinutes) {
      const over = paid - rules.overtimeAfterMinutes;
      const extra = Math.round((over * person.hourlyRateCents * (rules.overtimeMultiplier - 1)) / 60);
      issues.push({
        level: "warn",
        code: "overtime",
        staffId: person.id,
        extraCostCents: extra,
        message: `${name} is scheduled ${hours(paid)}. ${hours(over)} past 48 is overtime at 1.5x, about ${money(extra)} extra.`,
      });
    } else if (paid >= rules.overtimeWarnAtMinutes) {
      issues.push({ level: "info", code: "near_overtime", staffId: person.id, message: `${name} is at ${hours(paid)}, close to the 48-hour overtime line.` });
    }
    if (person.maxWeekMinutes != null && paid > person.maxWeekMinutes) {
      issues.push({
        level: "warn",
        code: "max_hours",
        staffId: person.id,
        message: `${name} asked for at most ${hours(person.maxWeekMinutes)} a week and is scheduled ${hours(paid)}.`,
      });
    }
    if (longestRestMinutes(theirs, ctx) < rules.weeklyRestMinutes) {
      issues.push({ level: "warn", code: "weekly_rest", staffId: person.id, message: `${name} doesn't get 24 hours in a row off this week.` });
    }
  }

  for (const s of shifts) {
    if (!byId.has(s.staffId)) {
      issues.push({ level: "block", code: "unknown_staff", staffId: s.staffId, shiftId: s.id, message: `A shift on ${when(s.startAt, tz)} belongs to someone no longer on staff.` });
    }
  }
  if (breaksPlanned > 0) {
    issues.push({
      level: "info",
      code: "breaks",
      staffId: null,
      message: `${breaksPlanned} shift${breaksPlanned === 1 ? "" : "s"} over 5 hours will get a 30-minute break planned automatically.`,
    });
  }
  const rank = { block: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => rank[a.level] - rank[b.level]);
}
