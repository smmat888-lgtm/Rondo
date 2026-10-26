import { NextResponse } from "next/server";
import { getAvailability, listTimeOff, offersFor } from "@/lib/automation";
import { listNotifications } from "@/lib/notify";
import { checkPin, myWeek } from "@/lib/repo";
import { bad, body, currentVenue, runAutomation, todayIn } from "@/lib/server";

// POST, not GET, so the PIN never ends up in a URL or server log.
export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ staffId: string; pin: string; week?: string }>(req);
  if (!input) return bad("Expected JSON");
  if (!checkPin(db, input.staffId, input.pin)) return bad("Wrong PIN", 401);
  await runAutomation(db, venue);
  return NextResponse.json({
    timezone: venue.timezone,
    ...myWeek(db, venue, input.staffId, input.week ?? todayIn(venue.timezone)),
    offers: offersFor(db, venue, input.staffId),
    notifications: listNotifications(db, venue.id, input.staffId, 10),
    availability: getAvailability(db, input.staffId),
    timeOff: listTimeOff(db, input.staffId),
  });
}
