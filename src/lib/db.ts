// Database. SQLite for now: free, one file, nothing to sign up for.
// The SQL is kept plain so it moves to Postgres (Supabase free tier) when the
// app goes online for pilot bars.

import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Loaded at runtime so bundlers don't try to package a Node built-in.
const { DatabaseSync: Sqlite } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  province TEXT NOT NULL DEFAULT 'NS',
  timezone TEXT NOT NULL DEFAULT 'America/Halifax',
  week_start INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  hourly_rate_cents INTEGER NOT NULL,
  pin_hash TEXT NOT NULL,
  tip_eligible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  role TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS shifts_by_time ON shifts(venue_id, start_at);
CREATE TABLE IF NOT EXISTS punches (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  type TEXT NOT NULL CHECK (type IN ('in','break_start','break_end','out')),
  client_time TEXT NOT NULL,
  received_at TEXT NOT NULL,
  receipt_code TEXT NOT NULL,
  synced_late INTEGER NOT NULL DEFAULT 0,
  flag TEXT
);
CREATE INDEX IF NOT EXISTS punches_by_staff ON punches(staff_id, client_time);
CREATE TABLE IF NOT EXISTS tip_pools (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  business_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (venue_id, business_date)
);
CREATE TABLE IF NOT EXISTS tip_shares (
  pool_id TEXT NOT NULL REFERENCES tip_pools(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  minutes INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (pool_id, staff_id)
);

-- Automation tables.
-- Availability: windows when someone can work, by day of week (0 = Sunday).
-- A staff member with no rows is treated as available any time.
CREATE TABLE IF NOT EXISTS availability (
  staff_id TEXT NOT NULL REFERENCES staff(id),
  dow INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  PRIMARY KEY (staff_id, dow)
);
CREATE TABLE IF NOT EXISTS time_off (
  staff_id TEXT NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (staff_id, date)
);
-- A week is a draft until the manager publishes it. Staff only see published weeks.
CREATE TABLE IF NOT EXISTS schedule_weeks (
  venue_id TEXT NOT NULL REFERENCES venues(id),
  week_start TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (venue_id, week_start)
);
-- Shifts with nobody on them yet. Rondo offers them to eligible staff in order.
CREATE TABLE IF NOT EXISTS open_shifts (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  role TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','open','filled','unfilled','cancelled')),
  reason TEXT,
  excluded_staff_id TEXT,
  filled_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS open_shifts_by_time ON open_shifts(venue_id, start_at);
CREATE TABLE IF NOT EXISTS shift_offers (
  id TEXT PRIMARY KEY,
  open_shift_id TEXT NOT NULL REFERENCES open_shifts(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  wave INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired','taken')),
  responded_at TEXT,
  UNIQUE (open_shift_id, staff_id)
);
-- In-app messages. staff_id NULL means the managers' inbox.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  staff_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  email_to TEXT,
  email_status TEXT CHECK (email_status IN ('queued','sent','skipped','failed'))
);
CREATE INDEX IF NOT EXISTS notifications_by_staff ON notifications(venue_id, staff_id, created_at);
`;

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["staff", "email", "TEXT"],
  ["staff", "max_week_minutes", "INTEGER"],
];

function migrate(db: DatabaseSync) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function hashPin(staffId: string, pin: string): string {
  return createHash("sha256").update(`${staffId}:${pin}`).digest("hex");
}

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Sqlite(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const DEMO_VENUE = "venue-demo";

// A demo bar so the app has something to show on first run.
// Every demo PIN is 1234.
export function seedDemo(db: DB) {
  const exists = db.prepare("SELECT 1 FROM venues WHERE id = ?").get(DEMO_VENUE);
  if (exists) return;
  db.prepare("INSERT INTO venues (id, name) VALUES (?, ?)").run(DEMO_VENUE, "Demo Bar (sample data)");
  // id, name, role, rate, tip eligible, max hours a week they want (null = no limit)
  const people: [string, string, string, number, number, number | null][] = [
    ["staff-maria", "Maria Lopez", "Bartender", 1800, 1, null],
    ["staff-noah", "Noah Gallant", "Bartender", 1750, 1, 24],
    ["staff-jamal", "Jamal Reid", "Server", 1700, 1, null],
    ["staff-sophie", "Sophie Tremblay", "Server", 1700, 1, null],
    ["staff-priya", "Priya Nair", "Server", 1700, 1, 20],
    ["staff-liam", "Liam MacDonald", "Line cook", 2100, 1, null],
    ["staff-ava", "Ava Chen", "Manager", 2600, 0, null],
  ];
  const ins = db.prepare(
    "INSERT INTO staff (id, venue_id, name, role, hourly_rate_cents, pin_hash, tip_eligible, email, max_week_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [id, name, role, rate, tips, maxHours] of people) {
    const email = `${id.replace("staff-", "")}@example.com`;
    ins.run(id, DEMO_VENUE, name, role, rate, hashPin(id, "1234"), tips, email, maxHours == null ? null : maxHours * 60);
  }
}
