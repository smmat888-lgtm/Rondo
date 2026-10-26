// All reads and writes the screens need, in one place.

import { randomUUID } from "node:crypto";
import { hashPin, type DB } from "./db";
import { buildSessions, clockState, type Punch, type PunchType, type Session } from "./hours";
import { weekPay, type WeekPay } from "./pay";
import { receiptCode } from "./receipt";
import { rulesFor } from "./rules";
import { splitTips } from "./tips";
import { addDays, localParts, startOfWeek, weekDates, zonedToUtc } from "./time";

export type Venue = { id: string; name: string; province: string; timezone: string; weekStart: number };
export type Staff = {
  id: string;
  name: string;
  role: string;
  hourlyRateCents: number;
  tipEligible: boolean;
  email: string | null;
  maxWeekMinutes: number | null;
};
export type Shift = { id: string; staffId: string; role: string; startAt: string; endAt: string; note: string | null };

// SQLite rows come back as loose objects; these mappers give them proper types.
type Row = Record<string, unknown>;
const str = (v: unknown) => String(v);

export function getVenue(db: DB, venueId: string): Venue {
  const r = db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as Row | undefined;
  if (!r) throw new Error("Venue not found");
  return { id: str(r.id), name: str(r.name), province: str(r.province), timezone: str(r.timezone), weekStart: Number(r.week_start) };
}

export function listStaff(db: DB, venueId: string): Staff[] {
  const rows = db
    .prepare("SELECT * FROM staff WHERE venue_id = ? AND active = 1 ORDER BY name")
    .all(venueId) as Row[];
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    role: str(r.role),
    hourlyRateCents: Number(r.hourly_rate_cents),
    tipEligible: Number(r.tip_eligible) === 1,
    email: r.email == null ? null : str(r.email),
    maxWeekMinutes: r.max_week_minutes == null ? null : Number(r.max_week_minutes),
  }));
}

export function checkPin(db: DB, staffId: string, pin: string): boolean {
  const r = db.prepare("SELECT pin_hash FROM staff WHERE id = ?").get(staffId) as Row | undefined;
  return !!r && r.pin_hash === hashPin(staffId, pin);
}

// ---------- Schedule ----------

export function weekRange(venue: Venue, anyDate: string) {
  const start = startOfWeek(anyDate, venue.weekStart);
  return {
    start,
    days: weekDates(start),
    fromUtc: zonedToUtc(start, "00:00", venue.timezone),
    toUtc: zonedToUtc(addDays(start, 7), "00:00", venue.timezone),
  };
}

export function listShifts(db: DB, venueId: string, fromUtc: string, toUtc: string): Shift[] {
  const rows = db
    .prepare("SELECT * FROM shifts WHERE venue_id = ? AND start_at >= ? AND start_at < ? ORDER BY start_at")
    .all(venueId, fromUtc, toUtc) as Row[];
  return rows.map(toShift);
}

export function getShift(db: DB, venueId: string, shiftId: string): Shift | null {
  const r = db.prepare("SELECT * FROM shifts WHERE id = ? AND venue_id = ?").get(shiftId, venueId) as Row | undefined;
  return r ? toShift(r) : null;
}

const toShift = (r: Row): Shift => ({
  id: str(r.id),
  staffId: str(r.staff_id),
  role: str(r.role),
  startAt: str(r.start_at),
  endAt: str(r.end_at),
  note: r.note == null ? null : str(r.note),
});

export function insertShift(db: DB, venueId: string, shift: Shift) {
  db.prepare("INSERT INTO shifts (id, venue_id, staff_id, role, start_at, end_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    shift.id,
    venueId,
    shift.staffId,
    shift.role,
    shift.startAt,
    shift.endAt,
    shift.note,
  );
}

// Times are local to the venue. An end time earlier than the start means the
// shift runs past midnight (e.g. 18:00 to 02:00).
export function createShift(
  db: DB,
  venue: Venue,
  input: { staffId: string; date: string; start: string; end: string; role?: string; note?: string },
): Shift {
  const staff = listStaff(db, venue.id).find((s) => s.id === input.staffId);
  if (!staff) throw new Error("Unknown staff member");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.start) || !/^\d{2}:\d{2}$/.test(input.end)) {
    throw new Error("Date must be YYYY-MM-DD and times HH:MM");
  }
  if (input.start === input.end) throw new Error("Shift needs a length");
  const endDate = input.end < input.start ? addDays(input.date, 1) : input.date;
  const shift: Shift = {
    id: randomUUID(),
    staffId: staff.id,
    role: input.role || staff.role,
    startAt: zonedToUtc(input.date, input.start, venue.timezone),
    endAt: zonedToUtc(endDate, input.end, venue.timezone),
    note: input.note || null,
  };
  insertShift(db, venue.id, shift);
  return shift;
}

export function deleteShift(db: DB, venueId: string, shiftId: string): boolean {
  return Number(db.prepare("DELETE FROM shifts WHERE id = ? AND venue_id = ?").run(shiftId, venueId).changes) > 0;
}

export function isPublished(db: DB, venueId: string, weekStart: string): boolean {
  const r = db.prepare("SELECT published_at FROM schedule_weeks WHERE venue_id = ? AND week_start = ?").get(venueId, weekStart) as Row | undefined;
  return !!r && r.published_at != null;
}

// ---------- Time clock ----------

export type PunchResult =
  | { status: "saved" | "duplicate"; receiptCode: string; syncedLate: boolean; flag: string | null }
  | { status: "rejected"; reason: string };

const LATE_SYNC_MS = 2 * 60 * 1000;
const VALID_TYPES: PunchType[] = ["in", "break_start", "break_end", "out"];

// Saves a punch exactly once. The device makes the id, so a punch sent twice
// (retry after a dropped connection) is stored once and gets the same receipt.
export function recordPunch(
  db: DB,
  venueId: string,
  input: { id: string; staffId: string; type: PunchType; clientTime: string; pin: string },
  now = new Date(),
): PunchResult {
  if (!input.id || !VALID_TYPES.includes(input.type) || Number.isNaN(Date.parse(input.clientTime))) {
    return { status: "rejected", reason: "Malformed punch" };
  }
  const existing = db.prepare("SELECT receipt_code, synced_late, flag FROM punches WHERE id = ?").get(input.id) as Row | undefined;
  if (existing) {
    return {
      status: "duplicate",
      receiptCode: str(existing.receipt_code),
      syncedLate: Number(existing.synced_late) === 1,
      flag: existing.flag == null ? null : str(existing.flag),
    };
  }
  const staff = listStaff(db, venueId).find((s) => s.id === input.staffId);
  if (!staff) return { status: "rejected", reason: "Unknown staff member" };
  if (!checkPin(db, input.staffId, input.pin)) return { status: "rejected", reason: "Wrong PIN" };

  const clientTime = new Date(input.clientTime).toISOString();
  const syncedLate = now.getTime() - Date.parse(clientTime) > LATE_SYNC_MS;
  // Device clocks can be wrong. Keep the punch, but flag big gaps for the manager.
  let flag: string | null = null;
  if (Date.parse(clientTime) - now.getTime() > LATE_SYNC_MS) flag = "Device clock is ahead of server time";
  else if (now.getTime() - Date.parse(clientTime) > 24 * 60 * 60 * 1000) flag = "Synced more than a day late";

  const code = receiptCode({ id: input.id, staffId: input.staffId, type: input.type, clientTime: input.clientTime });
  db.prepare(
    "INSERT INTO punches (id, venue_id, staff_id, type, client_time, received_at, receipt_code, synced_late, flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(input.id, venueId, input.staffId, input.type, clientTime, now.toISOString(), code, syncedLate ? 1 : 0, flag);
  return { status: "saved", receiptCode: code, syncedLate, flag };
}

export type StoredPunch = Punch & { receiptCode: string; syncedLate: boolean; flag: string | null; receivedAt: string };

export function listPunches(db: DB, staffId: string, fromUtc: string, toUtc: string): StoredPunch[] {
  const rows = db
    .prepare("SELECT * FROM punches WHERE staff_id = ? AND client_time >= ? AND client_time < ? ORDER BY client_time")
    .all(staffId, fromUtc, toUtc) as Row[];
  return rows.map((r) => ({
    id: str(r.id),
    staffId: str(r.staff_id),
    type: str(r.type) as PunchType,
    clientTime: str(r.client_time),
    receivedAt: str(r.received_at),
    receiptCode: str(r.receipt_code),
    syncedLate: Number(r.synced_late) === 1,
    flag: r.flag == null ? null : str(r.flag),
  }));
}

export function currentClockStates(db: DB, venueId: string, now = new Date()): Record<string, "off" | "on" | "break"> {
  const from = new Date(now.getTime() - 36 * 3600 * 1000).toISOString();
  const to = new Date(now.getTime() + 3600 * 1000).toISOString();
  const out: Record<string, "off" | "on" | "break"> = {};
  for (const s of listStaff(db, venueId)) out[s.id] = clockState(listPunches(db, s.id, from, to));
  return out;
}

// Sessions that start inside [fromUtc, toUtc). Punches are read with a day of
// padding on each side so a shift crossing midnight isn't cut in half.
export function sessionsFor(db: DB, staffId: string, fromUtc: string, toUtc: string): Session[] {
  const pad = 24 * 3600 * 1000;
  const punches = listPunches(
    db,
    staffId,
    new Date(Date.parse(fromUtc) - pad).toISOString(),
    new Date(Date.parse(toUtc) + pad).toISOString(),
  );
  return buildSessions(punches).filter((s) => s.start >= fromUtc && s.start < toUtc);
}

// ---------- My hours ----------

export type MyWeek = {
  staff: Staff;
  week: string[];
  shifts: Shift[];
  sessions: Session[];
  punches: StoredPunch[];
  pay: WeekPay;
  tipsCents: number;
};

export function myWeek(db: DB, venue: Venue, staffId: string, anyDate: string): MyWeek {
  const staff = listStaff(db, venue.id).find((s) => s.id === staffId);
  if (!staff) throw new Error("Unknown staff member");
  const range = weekRange(venue, anyDate);
  const sessions = sessionsFor(db, staffId, range.fromUtc, range.toUtc);
  const tips = db
    .prepare(
      `SELECT COALESCE(SUM(ts.amount_cents), 0) AS total FROM tip_shares ts
       JOIN tip_pools tp ON tp.id = ts.pool_id
       WHERE ts.staff_id = ? AND tp.venue_id = ? AND tp.business_date >= ? AND tp.business_date < ?`,
    )
    .get(staffId, venue.id, range.start, addDays(range.start, 7)) as Row;
  return {
    staff,
    week: range.days,
    // Staff see a week only once the manager publishes it.
    shifts: isPublished(db, venue.id, range.start)
      ? listShifts(db, venue.id, range.fromUtc, range.toUtc).filter((s) => s.staffId === staffId)
      : [],
    sessions,
    punches: listPunches(db, staffId, range.fromUtc, range.toUtc),
    pay: weekPay(sessions, staff.hourlyRateCents, rulesFor(venue.province)),
    tipsCents: Number(tips.total),
  };
}

// ---------- Tips ----------

export type TipDay = {
  date: string;
  poolCents: number | null;
  shares: { staffId: string; name: string; minutes: number; amountCents: number }[];
};

function workedMinutesOn(db: DB, venue: Venue, date: string) {
  const from = zonedToUtc(date, "00:00", venue.timezone);
  const to = zonedToUtc(addDays(date, 1), "00:00", venue.timezone);
  return listStaff(db, venue.id)
    .filter((s) => s.tipEligible)
    .map((s) => ({
      staffId: s.id,
      name: s.name,
      minutes: sessionsFor(db, s.id, from, to).reduce((t, x) => t + x.paidMinutes, 0),
    }));
}

export function getTipDay(db: DB, venue: Venue, date: string): TipDay {
  const pool = db.prepare("SELECT * FROM tip_pools WHERE venue_id = ? AND business_date = ?").get(venue.id, date) as
    | Row
    | undefined;
  const names = new Map(listStaff(db, venue.id).map((s) => [s.id, s.name]));
  if (pool) {
    const rows = db.prepare("SELECT * FROM tip_shares WHERE pool_id = ? ORDER BY amount_cents DESC").all(str(pool.id)) as Row[];
    return {
      date,
      poolCents: Number(pool.amount_cents),
      shares: rows.map((r) => ({
        staffId: str(r.staff_id),
        name: names.get(str(r.staff_id)) ?? "Former staff",
        minutes: Number(r.minutes),
        amountCents: Number(r.amount_cents),
      })),
    };
  }
  // No pool saved yet: show who worked, so the manager sees the split before saving.
  return { date, poolCents: null, shares: workedMinutesOn(db, venue, date).map((w) => ({ ...w, amountCents: 0 })) };
}

// Saving again for the same day replaces the earlier split (e.g. a late cash count).
export function saveTipPool(db: DB, venue: Venue, date: string, amountCents: number): TipDay {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error("Tip amount must be zero or more");
  const workers = workedMinutesOn(db, venue, date);
  const shares = splitTips(amountCents, workers);
  const id = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM tip_pools WHERE venue_id = ? AND business_date = ?").run(venue.id, date);
    db.prepare("INSERT INTO tip_pools (id, venue_id, business_date, amount_cents, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      venue.id,
      date,
      amountCents,
      new Date().toISOString(),
    );
    const ins = db.prepare("INSERT INTO tip_shares (pool_id, staff_id, minutes, amount_cents) VALUES (?, ?, ?, ?)");
    for (const s of shares) if (s.minutes > 0) ins.run(id, s.staffId, s.minutes, s.amountCents);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getTipDay(db, venue, date);
}

export function localDateOf(venue: Venue, iso: string): string {
  return localParts(iso, venue.timezone).date;
}
