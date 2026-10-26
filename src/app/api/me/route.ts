import { NextResponse } from "next/server";
import { checkPin, myWeek } from "@/lib/repo";
import { bad, body, currentVenue, todayIn } from "@/lib/server";

// POST, not GET, so the PIN never ends up in a URL or server log.
export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ staffId: string; pin: string; week?: string }>(req);
  if (!input) return bad("Expected JSON");
  if (!checkPin(db, input.staffId, input.pin)) return bad("Wrong PIN", 401);
  return NextResponse.json({ timezone: venue.timezone, ...myWeek(db, venue, input.staffId, input.week ?? todayIn(venue.timezone)) });
}
