// Shared bits for API routes. There is one demo venue until sign-in exists;
// every route goes through currentVenue() so adding accounts later is one change.

import { NextResponse } from "next/server";
import { DEMO_VENUE, openDb, seedDemo, type DB } from "./db";
import { seedDemoActivity } from "./demo";
import { tickOpenShifts } from "./automation";
import { flushEmail } from "./notify";
import { checkPin, getVenue, type Venue } from "./repo";

const g = globalThis as unknown as { rondoDb?: DB };

export function getDb(): DB {
  if (!g.rondoDb) {
    g.rondoDb = openDb(process.env.RONDO_DB ?? "data/rondo.db");
    seedDemo(g.rondoDb);
    seedDemoActivity(g.rondoDb);
  }
  return g.rondoDb;
}

export function currentVenue() {
  const db = getDb();
  return { db, venue: getVenue(db, DEMO_VENUE) };
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function todayIn(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

// Runs the automatic steps (open-shift offers) and sends any queued email copies.
// Called from the routes the screens poll, so offers move forward with no cron.
export async function runAutomation(db: DB, venue: Venue, now = new Date()) {
  tickOpenShifts(db, venue, now);
  await flushEmail(db);
}

// Staff actions are signed with name + PIN until real accounts exist.
export function staffFromPin(db: DB, input: { staffId?: string; pin?: string } | null): string | null {
  if (!input?.staffId || !input.pin) return null;
  return checkPin(db, input.staffId, input.pin) ? input.staffId : null;
}
