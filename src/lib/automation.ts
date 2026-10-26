// The automatic parts of scheduling, wired to the database:
//   - availability and time off
//   - auto-build a week's draft
//   - rule check and publish
//   - open shifts and call-outs, offered to eligible staff in order until someone says yes
//
// Nothing here costs money to run. Offers move forward whenever tickOpenShifts
// runs: on every screen load, and from a free scheduled ping once hosted.

import { randomUUID } from "node:crypto";
import { buildDraft, score, type Draft, type HistoryWeek } from "./autoschedule";
import {
  canAssign,
  checkSchedule,
  plannedBreak,
  timeOf,
  when,
  type AvailabilityWindow,
  type Context,
  type Issue,
  type PlanShift,
  type PlanStaff,
  type TimeOff,
} from "./compliance";
import type { DB } from "./db";
import { notify } from "./notify";
import { getShift, insertShift, isPublished, listShifts, listStaff, weekRange, type Shift, type Venue } from "./repo";
import { rulesFor } from "./rules";
import { addDays, localParts, zonedToUtc } from "./time";

type Row = Record<string, unknown>;
const str = (v: unknown) => String(v);
const HHMM = /^\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Availability and time off ----------

export function getAvailability(db: DB, staffId: string): AvailabilityWindow[] {
  const rows = db.prepare("SELECT * FROM availability WHERE staff_id = ? ORDER BY dow").all(staffId) as Row[];
  return rows.map((r) => ({ staffId, dow: Number(r.dow), start: str(r.start_time), end: str(r.end_time) }));
}

// Replaces someone's weekly availability. An empty list means "any time".
// A day left out of a non-empty list means "not available that day".
export function setAvailability(db: DB, staffId: string, windows: { dow: number; start: string; end: string }[]) {
  for (const w of windows) {
    if (!Number.isInteger(w.dow) || w.dow < 0 || w.dow > 6 || !HHMM.test(w.start) || !HHMM.test(w.end)) {
      throw new Error("Availability needs a day (0-6) and HH:MM times");
    }
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM availability WHERE staff_id = ?").run(staffId);
    const ins = db.prepare("INSERT INTO availability (staff_id, dow, start_time, end_time) VALUES (?, ?, ?, ?)");
    for (const w of windows) ins.run(staffId, w.dow, w.start, w.end);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listTimeOff(db: DB, staffId: string): { date: string; reason: string | null }[] {
  const rows = db.prepare("SELECT * FROM time_off WHERE staff_id = ? ORDER BY date").all(staffId) as Row[];
  return rows.map((r) => ({ date: str(r.date), reason: r.reason == null ? null : str(r.reason) }));
}

export function setTimeOff(db: DB, staffId: string, date: string, on: boolean, reason?: string) {
  if (!DATE.test(date)) throw new Error("Date must be YYYY-MM-DD");
  if (on) db.prepare("INSERT OR REPLACE INTO time_off (staff_id, date, reason) VALUES (?, ?, ?)").run(staffId, date, reason ?? null);
  else db.prepare("DELETE FROM time_off WHERE staff_id = ? AND date = ?").run(staffId, date);
}

// ---------- Shared context ----------

function planStaff(db: DB, venueId: string): PlanStaff[] {
  return listStaff(db, venueId).map(({ id, name, role, hourlyRateCents, maxWeekMinutes }) => ({ id, name, role, hourlyRateCents, maxWeekMinutes }));
}

function contextFor(db: DB, venue: Venue, weekStart: string): Context {
  const range = weekRange(venue, weekStart);
  const staffIds = listStaff(db, venue.id).map((s) => s.id);
  const availability = staffIds.flatMap((id) => getAvailability(db, id));
  const timeOff: TimeOff[] = staffIds.flatMap((id) => listTimeOff(db, id).map((t) => ({ staffId: id, date: t.date })));
  return { rules: rulesFor(venue.province), tz: venue.timezone, weekFromUtc: range.fromUtc, weekToUtc: range.toUtc, availability, timeOff };
}

const asPlan = (s: Shift): PlanShift => ({ id: s.id, staffId: s.staffId, role: s.role, startAt: s.startAt, endAt: s.endAt });

// ---------- Week status, check and publish ----------

export type WeekStatus = { weekStart: string; publishedAt: string | null };

export function weekStatus(db: DB, venue: Venue, anyDate: string): WeekStatus {
  const { start } = weekRange(venue, anyDate);
  const r = db.prepare("SELECT published_at FROM schedule_weeks WHERE venue_id = ? AND week_start = ?").get(venue.id, start) as Row | undefined;
  return { weekStart: start, publishedAt: r?.published_at == null ? null : str(r.published_at) };
}

export function checkWeek(db: DB, venue: Venue, anyDate: string): Issue[] {
  const range = weekRange(venue, anyDate);
  const shifts = listShifts(db, venue.id, range.fromUtc, range.toUtc).map(asPlan);
  const issues = checkSchedule(shifts, planStaff(db, venue.id), contextFor(db, venue, range.start));
  const open = listOpenShifts(db, venue, anyDate).filter((o) => o.status === "draft" || o.status === "open" || o.status === "unfilled");
  if (open.length) {
    issues.push({
      level: "info",
      code: "open_shifts",
      staffId: null,
      message: `${open.length} open shift${open.length === 1 ? "" : "s"} still need someone. Rondo offers them to eligible staff after you publish.`,
    });
  }
  return issues;
}

export type PublishResult = { published: boolean; issues: Issue[]; needsConfirm: boolean; breaksAdded: number };

export function publishWeek(db: DB, venue: Venue, anyDate: string, opts: { confirmWarnings?: boolean } = {}, now = new Date()): PublishResult {
  const range = weekRange(venue, anyDate);
  const issues = checkWeek(db, venue, anyDate);
  const blocked = issues.some((i) => i.level === "block");
  const needsConfirm = !blocked && issues.some((i) => i.level === "warn") && !opts.confirmWarnings;
  if (blocked || needsConfirm) return { published: false, issues, needsConfirm, breaksAdded: 0 };

  const rules = rulesFor(venue.province);
  const shifts = listShifts(db, venue.id, range.fromUtc, range.toUtc);
  let breaksAdded = 0;
  db.exec("BEGIN");
  try {
    // Plan the legal break on every long shift so nobody has to remember it.
    const setNote = db.prepare("UPDATE shifts SET note = ? WHERE id = ?");
    for (const s of shifts) {
      const brk = plannedBreak(s.startAt, s.endAt, rules);
      if (brk && !s.note) {
        setNote.run(`30-min break around ${timeOf(brk.startAt, venue.timezone)}`, s.id);
        breaksAdded++;
      }
    }
    db.prepare(
      "INSERT INTO schedule_weeks (venue_id, week_start, published_at) VALUES (?, ?, ?) ON CONFLICT (venue_id, week_start) DO UPDATE SET published_at = excluded.published_at",
    ).run(venue.id, range.start, now.toISOString());
    db.prepare("UPDATE open_shifts SET status = 'open' WHERE venue_id = ? AND status = 'draft' AND start_at >= ? AND start_at < ?").run(
      venue.id,
      range.fromUtc,
      range.toUtc,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Tell each person their shifts for the week.
  const byStaff = new Map<string, Shift[]>();
  for (const s of listShifts(db, venue.id, range.fromUtc, range.toUtc)) byStaff.set(s.staffId, [...(byStaff.get(s.staffId) ?? []), s]);
  for (const [staffId, theirs] of byStaff) {
    const lines = theirs.map((s) => `${when(s.startAt, venue.timezone)} to ${timeOf(s.endAt, venue.timezone)}${s.note ? ` (${s.note})` : ""}`);
    notify(db, venue.id, staffId, `Your schedule for the week of ${range.start} is posted`, lines.join("\n"), now);
  }
  notify(db, venue.id, null, `Schedule for the week of ${range.start} published`, `${shifts.length} shifts sent to ${byStaff.size} people. ${breaksAdded} breaks planned.`, now);
  tickOpenShifts(db, venue, now);
  return { published: true, issues, needsConfirm: false, breaksAdded };
}

// ---------- Auto-build ----------

export type AutoBuildResult = Draft & { created: number; weekStart: string };

export function autoBuildWeek(
  db: DB,
  venue: Venue,
  anyDate: string,
  opts: { budgetCents?: number | null; replace?: boolean; historyWeeks?: number } = {},
  now = new Date(),
): AutoBuildResult {
  const range = weekRange(venue, anyDate);
  if (isPublished(db, venue.id, range.start)) throw new Error("This week is already published. Rondo only builds draft weeks.");
  const existing = listShifts(db, venue.id, range.fromUtc, range.toUtc);
  if (existing.length && !opts.replace) {
    throw new Error(`This week already has ${existing.length} shifts. Use Rebuild to replace the draft.`);
  }

  const history: HistoryWeek[] = [];
  for (let w = 1; w <= (opts.historyWeeks ?? 4); w++) {
    const past = weekRange(venue, addDays(range.start, -7 * w));
    const shifts = listShifts(db, venue.id, past.fromUtc, past.toUtc).map(asPlan);
    if (shifts.length) history.push({ weekStart: past.start, shifts });
  }

  const draft = buildDraft({ history, weekStart: range.start, staff: planStaff(db, venue.id), ctx: contextFor(db, venue, range.start), budgetCents: opts.budgetCents });

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM shifts WHERE venue_id = ? AND start_at >= ? AND start_at < ?").run(venue.id, range.fromUtc, range.toUtc);
    db.prepare("DELETE FROM open_shifts WHERE venue_id = ? AND status = 'draft' AND start_at >= ? AND start_at < ?").run(venue.id, range.fromUtc, range.toUtc);
    for (const a of draft.assigned) {
      insertShift(db, venue.id, { id: randomUUID(), staffId: a.staffId, role: a.role, startAt: a.startAt, endAt: a.endAt, note: null });
    }
    for (const o of draft.open) insertOpenShift(db, venue.id, { role: o.role, startAt: o.startAt, endAt: o.endAt, status: "draft", reason: "Nobody eligible when the draft was built" }, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ...draft, created: draft.assigned.length, weekStart: range.start };
}

// ---------- Open shifts and offers ----------

export type OpenShift = {
  id: string;
  role: string;
  startAt: string;
  endAt: string;
  status: "draft" | "open" | "filled" | "unfilled" | "cancelled";
  reason: string | null;
  filledBy: string | null;
  offers: { staffId: string; status: string; wave: number; expiresAt: string }[];
};

// How widely to ask, by how soon the shift starts. Far out: one person at a
// time, the best fit first. Same day: everyone eligible at once, first yes wins.
export const OFFER_POLICY = [
  { minHoursAhead: 24, waveSize: 1, answerMinutes: 60 },
  { minHoursAhead: 3, waveSize: 3, answerMinutes: 20 },
  { minHoursAhead: 0, waveSize: Number.POSITIVE_INFINITY, answerMinutes: 15 },
];

function insertOpenShift(
  db: DB,
  venueId: string,
  o: { role: string; startAt: string; endAt: string; status: "draft" | "open"; reason: string; excludedStaffId?: string },
  now: Date,
): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO open_shifts (id, venue_id, role, start_at, end_at, status, reason, excluded_staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, venueId, o.role, o.startAt, o.endAt, o.status, o.reason, o.excludedStaffId ?? null, now.toISOString());
  return id;
}

function toOpenShift(db: DB, r: Row): OpenShift {
  const offers = db.prepare("SELECT * FROM shift_offers WHERE open_shift_id = ? ORDER BY wave, sent_at").all(str(r.id)) as Row[];
  return {
    id: str(r.id),
    role: str(r.role),
    startAt: str(r.start_at),
    endAt: str(r.end_at),
    status: str(r.status) as OpenShift["status"],
    reason: r.reason == null ? null : str(r.reason),
    filledBy: r.filled_by == null ? null : str(r.filled_by),
    offers: offers.map((o) => ({ staffId: str(o.staff_id), status: str(o.status), wave: Number(o.wave), expiresAt: str(o.expires_at) })),
  };
}

export function listOpenShifts(db: DB, venue: Venue, anyDate: string): OpenShift[] {
  const range = weekRange(venue, anyDate);
  const rows = db
    .prepare("SELECT * FROM open_shifts WHERE venue_id = ? AND start_at >= ? AND start_at < ? AND status != 'cancelled' ORDER BY start_at")
    .all(venue.id, range.fromUtc, range.toUtc) as Row[];
  return rows.map((r) => toOpenShift(db, r));
}

function getOpenShift(db: DB, venueId: string, id: string): (OpenShift & { excludedStaffId: string | null }) | null {
  const r = db.prepare("SELECT * FROM open_shifts WHERE id = ? AND venue_id = ?").get(id, venueId) as Row | undefined;
  return r ? { ...toOpenShift(db, r), excludedStaffId: r.excluded_staff_id == null ? null : str(r.excluded_staff_id) } : null;
}

const describe = (o: { role: string; startAt: string; endAt: string }, tz: string) =>
  `${o.role}, ${when(o.startAt, tz)} to ${timeOf(o.endAt, tz)}`;

// Everyone who could take this shift without breaking a rule, best fit first.
export function rankCandidates(db: DB, venue: Venue, o: { role: string; startAt: string; endAt: string }, exclude: string[] = []): PlanStaff[] {
  const weekStart = weekRange(venue, localParts(o.startAt, venue.timezone).date).start;
  const range = weekRange(venue, weekStart);
  const week = listShifts(db, venue.id, range.fromUtc, range.toUtc).map(asPlan);
  const ctx = contextFor(db, venue, weekStart);
  return planStaff(db, venue.id)
    .filter((p) => !exclude.includes(p.id) && canAssign(p, o, week, ctx).length === 0)
    .map((p) => ({ p, v: score(p, o, week, ctx) }))
    .sort((a, b) => b.v - a.v || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

// Manager posts a shift with nobody on it yet.
export function postOpenShift(db: DB, venue: Venue, input: { date: string; start: string; end: string; role: string }, now = new Date()): OpenShift {
  if (!DATE.test(input.date) || !HHMM.test(input.start) || !HHMM.test(input.end) || !input.role) {
    throw new Error("Open shift needs a role, a YYYY-MM-DD date and HH:MM times");
  }
  if (input.start === input.end) throw new Error("Shift needs a length");
  const startAt = zonedToUtc(input.date, input.start, venue.timezone);
  const endAt = zonedToUtc(input.end < input.start ? addDays(input.date, 1) : input.date, input.end, venue.timezone);
  const published = isPublished(db, venue.id, weekRange(venue, input.date).start);
  const id = insertOpenShift(db, venue.id, { role: input.role, startAt, endAt, status: published ? "open" : "draft", reason: "Posted by manager" }, now);
  tickOpenShifts(db, venue, now);
  return getOpenShift(db, venue.id, id)!;
}

// Someone can't make a shift (sick, emergency). The shift becomes open and Rondo
// starts asking others right away. Staff never have to find their own cover.
export function callOut(db: DB, venue: Venue, shiftId: string, reportedBy: "staff" | "manager", now = new Date()): OpenShift {
  const shift = getShift(db, venue.id, shiftId);
  if (!shift) throw new Error("Shift not found");
  if (Date.parse(shift.endAt) <= now.getTime()) throw new Error("That shift is already over");
  const person = listStaff(db, venue.id).find((s) => s.id === shift.staffId);
  const published = isPublished(db, venue.id, weekRange(venue, localParts(shift.startAt, venue.timezone).date).start);
  db.exec("BEGIN");
  let id: string;
  try {
    db.prepare("DELETE FROM shifts WHERE id = ?").run(shiftId);
    id = insertOpenShift(
      db,
      venue.id,
      { role: shift.role, startAt: shift.startAt, endAt: shift.endAt, status: published ? "open" : "draft", reason: `${person?.name ?? "Staff"} can't make it`, excludedStaffId: shift.staffId },
      now,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const what = describe(shift, venue.timezone);
  notify(db, venue.id, null, `${person?.name ?? "Someone"} can't make ${what}`, `${reportedBy === "staff" ? "They told Rondo themselves." : "Marked by a manager."} Rondo is finding cover now.`, now);
  if (person) notify(db, venue.id, person.id, `You're off ${what}`, "Your manager has been told and Rondo is finding cover. You don't need to find a replacement.", now);
  tickOpenShifts(db, venue, now);
  return getOpenShift(db, venue.id, id)!;
}

// Moves every open shift forward: expires unanswered offers, sends the next
// wave, and tells the manager when nobody is left to ask. Safe to run often.
export function tickOpenShifts(db: DB, venue: Venue, now = new Date()) {
  const nowIso = now.toISOString();
  const rows = db.prepare("SELECT * FROM open_shifts WHERE venue_id = ? AND status = 'open' ORDER BY start_at").all(venue.id) as Row[];
  for (const r of rows) {
    const id = str(r.id);
    const o = { role: str(r.role), startAt: str(r.start_at), endAt: str(r.end_at) };
    const what = describe(o, venue.timezone);
    db.prepare("UPDATE shift_offers SET status = 'expired' WHERE open_shift_id = ? AND status = 'pending' AND expires_at <= ?").run(id, nowIso);

    if (Date.parse(o.startAt) <= now.getTime()) {
      db.prepare("UPDATE open_shifts SET status = 'unfilled' WHERE id = ?").run(id);
      db.prepare("UPDATE shift_offers SET status = 'expired' WHERE open_shift_id = ? AND status = 'pending'").run(id);
      notify(db, venue.id, null, `Nobody picked up ${what}`, "The shift has started without cover.", now);
      continue;
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM shift_offers WHERE open_shift_id = ? AND status = 'pending'").get(id) as Row;
    if (Number(pending.n) > 0) continue;

    const asked = (db.prepare("SELECT staff_id FROM shift_offers WHERE open_shift_id = ?").all(id) as Row[]).map((x) => str(x.staff_id));
    const exclude = [...asked, ...(r.excluded_staff_id == null ? [] : [str(r.excluded_staff_id)])];
    const candidates = rankCandidates(db, venue, o, exclude);
    if (candidates.length === 0) {
      db.prepare("UPDATE open_shifts SET status = 'unfilled' WHERE id = ?").run(id);
      notify(
        db,
        venue.id,
        null,
        `No one available for ${what}`,
        asked.length
          ? `Rondo asked ${asked.length} ${asked.length === 1 ? "person" : "people"} and nobody said yes. You can assign someone by hand (it may mean overtime).`
          : "Nobody can take it without overtime, time off or availability conflicts. You can assign someone by hand.",
        now,
      );
      continue;
    }

    const hoursAhead = (Date.parse(o.startAt) - now.getTime()) / 3600000;
    const policy = OFFER_POLICY.find((p) => hoursAhead >= p.minHoursAhead)!;
    const waveRow = db.prepare("SELECT COALESCE(MAX(wave), 0) AS w FROM shift_offers WHERE open_shift_id = ?").get(id) as Row;
    const wave = Number(waveRow.w) + 1;
    const expires = new Date(Math.min(now.getTime() + policy.answerMinutes * 60000, Date.parse(o.startAt))).toISOString();
    const ins = db.prepare("INSERT INTO shift_offers (id, open_shift_id, staff_id, wave, sent_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')");
    for (const p of candidates.slice(0, policy.waveSize)) {
      ins.run(randomUUID(), id, p.id, wave, nowIso, expires);
      notify(db, venue.id, p.id, `Shift up for grabs: ${what}`, `Can you take it? Answer in Rondo within ${policy.answerMinutes} minutes. First yes gets it.`, now);
    }
  }
}

export type MyOffer = { offerId: string; openShiftId: string; role: string; startAt: string; endAt: string; expiresAt: string };

export function offersFor(db: DB, venue: Venue, staffId: string, now = new Date()): MyOffer[] {
  const rows = db
    .prepare(
      `SELECT so.id AS offer_id, so.expires_at, os.* FROM shift_offers so JOIN open_shifts os ON os.id = so.open_shift_id
       WHERE so.staff_id = ? AND os.venue_id = ? AND so.status = 'pending' AND os.status = 'open' AND so.expires_at > ? ORDER BY os.start_at`,
    )
    .all(staffId, venue.id, now.toISOString()) as Row[];
  return rows.map((r) => ({ offerId: str(r.offer_id), openShiftId: str(r.id), role: str(r.role), startAt: str(r.start_at), endAt: str(r.end_at), expiresAt: str(r.expires_at) }));
}

export type OfferAnswer = { ok: true; shift?: Shift } | { ok: false; reason: string };

export function answerOffer(db: DB, venue: Venue, offerId: string, staffId: string, accept: boolean, now = new Date()): OfferAnswer {
  const offer = db.prepare("SELECT * FROM shift_offers WHERE id = ? AND staff_id = ?").get(offerId, staffId) as Row | undefined;
  if (!offer) return { ok: false, reason: "Offer not found" };
  const o = getOpenShift(db, venue.id, str(offer.open_shift_id));
  if (!o) return { ok: false, reason: "Offer not found" };
  if (o.status !== "open") return { ok: false, reason: o.status === "filled" ? "Someone else already took this shift" : "This shift is no longer open" };
  if (!["pending", "expired"].includes(str(offer.status))) return { ok: false, reason: "You already answered this one" };

  if (!accept) {
    db.prepare("UPDATE shift_offers SET status = 'declined', responded_at = ? WHERE id = ?").run(now.toISOString(), offerId);
    tickOpenShifts(db, venue, now);
    return { ok: true };
  }

  // Check the rules again: their week may have changed since the offer went out.
  if (rankCandidates(db, venue, o).every((p) => p.id !== staffId)) {
    return { ok: false, reason: "You can't take this one anymore (it would clash with your other shifts or hours)" };
  }
  const shift: Shift = { id: randomUUID(), staffId, role: o.role, startAt: o.startAt, endAt: o.endAt, note: null };
  const brk = plannedBreak(o.startAt, o.endAt, rulesFor(venue.province));
  if (brk) shift.note = `30-min break around ${timeOf(brk.startAt, venue.timezone)}`;
  const others = (db.prepare("SELECT staff_id FROM shift_offers WHERE open_shift_id = ? AND status = 'pending' AND staff_id != ?").all(o.id, staffId) as Row[]).map((x) => str(x.staff_id));
  db.exec("BEGIN");
  try {
    insertShift(db, venue.id, shift);
    db.prepare("UPDATE open_shifts SET status = 'filled', filled_by = ? WHERE id = ?").run(staffId, o.id);
    db.prepare("UPDATE shift_offers SET status = 'accepted', responded_at = ? WHERE id = ?").run(now.toISOString(), offerId);
    db.prepare("UPDATE shift_offers SET status = 'taken' WHERE open_shift_id = ? AND status = 'pending'").run(o.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const what = describe(o, venue.timezone);
  const name = listStaff(db, venue.id).find((s) => s.id === staffId)?.name ?? "Someone";
  notify(db, venue.id, staffId, `You're on: ${what}`, shift.note ?? "Thanks for picking it up.", now);
  for (const other of others) notify(db, venue.id, other, `Taken: ${what}`, `${name} picked it up. Nothing for you to do.`, now);
  notify(db, venue.id, null, `${name} picked up ${what}`, "Filled automatically. Nothing for you to do.", now);
  return { ok: true, shift };
}
