// Fills the demo bar with a realistic week: shifts for this week and next,
// and punches for the last few nights, so every screen has something to show.

import { randomUUID } from "node:crypto";
import { DEMO_VENUE, type DB } from "./db";
import { createShift, getVenue, recordPunch, saveTipPool } from "./repo";
import { addDays, startOfWeek, zonedToUtc } from "./time";

const PLAN: [string, number, string, string][] = [
  // staff, day of week (0 = Monday), start, end
  ["staff-maria", 2, "16:00", "00:00"],
  ["staff-maria", 3, "16:00", "00:00"],
  ["staff-maria", 4, "17:00", "02:00"],
  ["staff-maria", 5, "17:00", "02:00"],
  ["staff-jamal", 3, "17:00", "23:00"],
  ["staff-jamal", 4, "17:00", "23:00"],
  ["staff-jamal", 5, "17:00", "01:00"],
  ["staff-sophie", 0, "11:00", "16:00"],
  ["staff-sophie", 1, "11:00", "16:00"],
  ["staff-sophie", 4, "18:00", "02:00"],
  ["staff-sophie", 5, "18:00", "02:00"],
  ["staff-liam", 1, "15:00", "23:00"],
  ["staff-liam", 2, "15:00", "23:00"],
  ["staff-liam", 3, "15:00", "23:00"],
  ["staff-liam", 4, "15:00", "00:00"],
  ["staff-liam", 5, "15:00", "00:00"],
  ["staff-ava", 3, "15:00", "23:00"],
  ["staff-ava", 4, "15:00", "01:00"],
  ["staff-ava", 5, "15:00", "01:00"],
];

export function seedDemoActivity(db: DB, now = new Date()) {
  if (db.prepare("SELECT 1 FROM shifts LIMIT 1").get()) return;
  const venue = getVenue(db, DEMO_VENUE);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: venue.timezone }).format(now);
  const monday = startOfWeek(today, venue.weekStart);

  for (const week of [-7, 0, 7]) {
    for (const [staffId, dow, start, end] of PLAN) {
      createShift(db, venue, { staffId, date: addDays(monday, week + dow), start, end });
    }
  }

  // Punches for shifts that already ended, roughly matching the schedule.
  const tipDays = new Set<string>();
  for (const week of [-7, 0]) {
    for (const [staffId, dow, start, end] of PLAN) {
      const date = addDays(monday, week + dow);
      const endDate = end < start ? addDays(date, 1) : date;
      const inAt = new Date(Date.parse(zonedToUtc(date, start, venue.timezone)) + jitter(staffId, date) * 60000);
      const outAt = new Date(Date.parse(zonedToUtc(endDate, end, venue.timezone)) + jitter(date, staffId) * 60000);
      if (outAt > now) continue;
      const brk = new Date(inAt.getTime() + 4 * 3600 * 1000);
      const punches: [string, Date][] = [["in", inAt]];
      if (outAt.getTime() - inAt.getTime() > 5 * 3600 * 1000) {
        punches.push(["break_start", brk], ["break_end", new Date(brk.getTime() + 30 * 60000)]);
      }
      punches.push(["out", outAt]);
      for (const [type, at] of punches) {
        recordPunch(
          db,
          venue.id,
          { id: randomUUID(), staffId, type: type as "in", clientTime: at.toISOString(), pin: "1234" },
          new Date(at.getTime() + 1000),
        );
      }
      tipDays.add(date);
    }
  }
  for (const d of tipDays) saveTipPool(db, venue, d, 25000 + (d.charCodeAt(9) % 7) * 6500);
}

// Small, repeatable offsets so demo punches don't all land on the minute.
function jitter(a: string, b: string): number {
  let h = 0;
  for (const c of a + b) h = (h * 31 + c.charCodeAt(0)) % 997;
  return (h % 11) - 5;
}
