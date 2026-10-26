import { NextResponse } from "next/server";
import { currentClockStates, listStaff } from "@/lib/repo";
import { currentVenue } from "@/lib/server";

export const dynamic = "force-dynamic";

// Staff list for the schedule and clock screens. Pay rates are left out on purpose.
export function GET() {
  const { db, venue } = currentVenue();
  const states = currentClockStates(db, venue.id);
  const staff = listStaff(db, venue.id).map(({ id, name, role }) => ({ id, name, role, state: states[id] }));
  return NextResponse.json({ venue: { name: venue.name, timezone: venue.timezone }, staff });
}
