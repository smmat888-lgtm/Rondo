// Auto-build a week's schedule draft.
//
// 1. Work out what the bar needs from the last few weeks: which roles, which
//    days, which start and end times, and how many people (the median week).
// 2. Fill each slot with the best eligible person: someone who usually works
//    that shift, then whoever has the fewest hours so far, then the lower rate.
//    Hard rules come from compliance.canAssign, so the draft never puts anyone
//    into overtime, outside their availability or on their time off.
// 3. If a weekly labour budget is set and the draft costs more, drop the
//    least regular shifts first, never the last person in a role on a day.
//
// The manager gets a draft to look over, not a published schedule.

import { canAssign, plannedCostCents, plannedPaidMinutes, type Context, type PlanShift, type PlanStaff } from "./compliance";
import { addDays, localParts, minutesBetween, zonedToUtc } from "./time";

export type HistoryWeek = { weekStart: string; shifts: PlanShift[] };

export type Slot = {
  key: string;
  role: string;
  startAt: string;
  endAt: string;
  confidence: number; // share of past weeks that had this shift, 0 to 1
  usualStaff: Record<string, number>; // staffId -> weeks they worked it
};

export type Draft = {
  assigned: (PlanShift & { slotKey: string })[];
  open: Slot[];
  trimmed: Slot[];
  costCents: number;
  budgetCents: number | null;
  notes: string[];
};

const dayIndex = (weekStart: string, date: string) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${weekStart}T12:00:00Z`)) / 86400000);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function demandFromHistory(history: HistoryWeek[], weekStart: string, tz: string): Slot[] {
  if (history.length === 0) return [];
  type Pattern = { day: number; role: string; start: string; end: string; endDay: number; perWeek: number[]; staff: Record<string, Set<number>> };
  const patterns = new Map<string, Pattern>();

  history.forEach((week, w) => {
    for (const s of week.shifts) {
      const a = localParts(s.startAt, tz);
      const b = localParts(s.endAt, tz);
      const day = dayIndex(week.weekStart, a.date);
      if (day < 0 || day > 6) continue;
      const endDay = dayIndex(a.date, b.date);
      const key = `${day}|${s.role}|${a.time}|${b.time}|${endDay}`;
      let p = patterns.get(key);
      if (!p) {
        p = { day, role: s.role, start: a.time, end: b.time, endDay, perWeek: history.map(() => 0), staff: {} };
        patterns.set(key, p);
      }
      p.perWeek[w]++;
      (p.staff[s.staffId] ??= new Set()).add(w);
    }
  });

  const slots: Slot[] = [];
  for (const [key, p] of patterns) {
    const needed = Math.round(median(p.perWeek));
    const date = addDays(weekStart, p.day);
    const startAt = zonedToUtc(date, p.start, tz);
    const endAt = zonedToUtc(addDays(date, p.endDay), p.end, tz);
    const confidence = p.perWeek.filter((n) => n > 0).length / history.length;
    const usualStaff = Object.fromEntries(Object.entries(p.staff).map(([id, weeks]) => [id, weeks.size]));
    for (let i = 0; i < needed; i++) slots.push({ key: `${key}#${i}`, role: p.role, startAt, endAt, confidence, usualStaff });
  }
  return slots.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.role.localeCompare(b.role));
}

// Higher is better. Exported so open-shift offers rank people the same way.
export function score(person: PlanStaff, shift: { startAt: string; endAt: string }, week: PlanShift[], ctx: Context, usual = 0): number {
  const theirs = week.filter((s) => s.staffId === person.id);
  const paidSoFar = theirs.reduce((t, s) => t + plannedPaidMinutes(s.startAt, s.endAt, ctx.rules), 0);
  const shortTurnaround = theirs.some(
    (s) => Math.abs(minutesBetween(s.endAt, shift.startAt)) < 8 * 60 || Math.abs(minutesBetween(shift.endAt, s.startAt)) < 8 * 60,
  );
  return usual * 10 - paidSoFar / 60 - person.hourlyRateCents / 1000 - (shortTurnaround ? 5 : 0);
}

export function buildDraft(input: { history: HistoryWeek[]; weekStart: string; staff: PlanStaff[]; ctx: Context; budgetCents?: number | null }): Draft {
  const { staff, ctx } = input;
  const budgetCents = input.budgetCents ?? null;
  const slots = demandFromHistory(input.history, input.weekStart, ctx.tz);
  const notes: string[] = [];
  if (input.history.length === 0) notes.push("No past weeks to learn from yet. Build one week by hand and Rondo will copy its pattern.");

  // Hardest slots first: the ones the fewest people can work.
  const eligibleCount = new Map(slots.map((s) => [s.key, staff.filter((p) => canAssign(p, s, [], ctx).length === 0).length]));
  const order = [...slots].sort((a, b) => eligibleCount.get(a.key)! - eligibleCount.get(b.key)! || Date.parse(a.startAt) - Date.parse(b.startAt));

  const assigned: Draft["assigned"] = [];
  const open: Slot[] = [];
  for (const slot of order) {
    const best = staff
      .filter((p) => canAssign(p, slot, assigned, ctx).length === 0)
      .map((p) => ({ p, v: score(p, slot, assigned, ctx, slot.usualStaff[p.id] ?? 0) }))
      .sort((a, b) => b.v - a.v || a.p.name.localeCompare(b.p.name))[0];
    if (best) assigned.push({ staffId: best.p.id, role: slot.role, startAt: slot.startAt, endAt: slot.endAt, slotKey: slot.key });
    else open.push(slot);
  }

  const rate = new Map(staff.map((s) => [s.id, s.hourlyRateCents]));
  const roleRate = (role: string) => {
    const rates = staff.filter((s) => s.role === role).map((s) => s.hourlyRateCents);
    return rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : ctx.rules.minWageCents;
  };
  const costOf = () =>
    assigned.reduce((t, s) => t + plannedCostCents(s.startAt, s.endAt, rate.get(s.staffId)!, ctx.rules), 0) +
    open.reduce((t, s) => t + plannedCostCents(s.startAt, s.endAt, roleRate(s.role), ctx.rules), 0);

  const trimmed: Slot[] = [];
  if (budgetCents != null) {
    const bySlot = new Map(slots.map((s) => [s.key, s]));
    while (costOf() > budgetCents) {
      const day = (iso: string) => localParts(iso, ctx.tz).date;
      const live = [...assigned.map((a) => bySlot.get(a.slotKey)!), ...open];
      const sameRoleDay = (s: Slot) => live.filter((x) => x.role === s.role && day(x.startAt) === day(s.startAt)).length;
      const victim = live
        .filter((s) => sameRoleDay(s) > 1)
        .sort((a, b) => a.confidence - b.confidence || Date.parse(b.startAt) - Date.parse(a.startAt))[0];
      if (!victim) {
        notes.push("Couldn't get under the budget without leaving a role with nobody on a day.");
        break;
      }
      trimmed.push(victim);
      const ai = assigned.findIndex((a) => a.slotKey === victim.key);
      if (ai >= 0) assigned.splice(ai, 1);
      else open.splice(open.indexOf(victim), 1);
    }
  }

  assigned.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (input.history.length > 0) notes.push(`Built from the pattern of the last ${input.history.length} week${input.history.length === 1 ? "" : "s"}.`);
  if (open.length) notes.push(`${open.length} shift${open.length === 1 ? "" : "s"} had nobody eligible and ${open.length === 1 ? "is" : "are"} posted as open. Rondo offers ${open.length === 1 ? "it" : "them"} to staff once you publish.`);
  if (trimmed.length) notes.push(`Dropped ${trimmed.length} less regular shift${trimmed.length === 1 ? "" : "s"} to stay under the labour budget.`);
  return { assigned, open, trimmed, costCents: costOf(), budgetCents, notes };
}
