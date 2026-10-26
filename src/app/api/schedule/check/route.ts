import { NextResponse } from "next/server";
import { checkWeek } from "@/lib/automation";
import { bad, currentVenue, todayIn } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const { db, venue } = currentVenue();
  const week = new URL(req.url).searchParams.get("week") ?? todayIn(venue.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return bad("week must be YYYY-MM-DD");
  return NextResponse.json({ issues: checkWeek(db, venue, week) });
}
