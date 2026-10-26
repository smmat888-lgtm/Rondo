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
`;

export function hashPin(staffId: string, pin: string): string {
  return createHash("sha256").update(`${staffId}:${pin}`).digest("hex");
}

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Sqlite(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export const DEMO_VENUE = "venue-demo";

// A demo bar so the app has something to show on first run.
// Every demo PIN is 1234.
export function seedDemo(db: DB) {
  const exists = db.prepare("SELECT 1 FROM venues WHERE id = ?").get(DEMO_VENUE);
  if (exists) return;
  db.prepare("INSERT INTO venues (id, name) VALUES (?, ?)").run(DEMO_VENUE, "Demo Bar (sample data)");
  const people: [string, string, string, number, number][] = [
    ["staff-maria", "Maria Lopez", "Bartender", 1800, 1],
    ["staff-jamal", "Jamal Reid", "Server", 1700, 1],
    ["staff-sophie", "Sophie Tremblay", "Server", 1700, 1],
    ["staff-liam", "Liam MacDonald", "Line cook", 2100, 1],
    ["staff-ava", "Ava Chen", "Manager", 2600, 0],
  ];
  const ins = db.prepare(
    "INSERT INTO staff (id, venue_id, name, role, hourly_rate_cents, pin_hash, tip_eligible) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [id, name, role, rate, tips] of people) {
    ins.run(id, DEMO_VENUE, name, role, rate, hashPin(id, "1234"), tips);
  }
}
