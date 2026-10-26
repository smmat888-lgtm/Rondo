// Shared bits for API routes. There is one demo venue until sign-in exists;
// every route goes through currentVenue() so adding accounts later is one change.

import { NextResponse } from "next/server";
import { DEMO_VENUE, openDb, seedDemo, type DB } from "./db";
import { seedDemoActivity } from "./demo";
import { getVenue } from "./repo";

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
