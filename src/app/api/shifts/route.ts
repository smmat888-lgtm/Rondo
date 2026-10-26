import { NextResponse } from "next/server";
import { createShift, listShifts, weekRange } from "@/lib/repo";
import { bad, body, currentVenue, todayIn } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const { db, venue } = currentVenue();
  const date = new URL(req.url).searchParams.get("week") ?? todayIn(venue.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("week must be YYYY-MM-DD");
  const range = weekRange(venue, date);
  return NextResponse.json({ weekStart: range.start, days: range.days, shifts: listShifts(db, venue.id, range.fromUtc, range.toUtc) });
}

export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ staffId: string; date: string; start: string; end: string; role?: string; note?: string }>(req);
  if (!input) return bad("Expected JSON");
  try {
    return NextResponse.json(createShift(db, venue, input), { status: 201 });
  } catch (e) {
    return bad((e as Error).message);
  }
}
