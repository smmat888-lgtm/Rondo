import { NextResponse } from "next/server";
import { getAvailability, listTimeOff, setAvailability, setTimeOff } from "@/lib/automation";
import { bad, body, currentVenue, staffFromPin } from "@/lib/server";

// Staff set when they can work and ask for days off. The auto-scheduler and
// open-shift offers respect both.
export async function POST(req: Request) {
  const { db } = currentVenue();
  const input = await body<{
    staffId: string;
    pin: string;
    windows?: { dow: number; start: string; end: string }[];
    timeOff?: { date: string; on: boolean; reason?: string };
  }>(req);
  const staffId = staffFromPin(db, input);
  if (!input || !staffId) return bad("Wrong PIN", 401);
  try {
    if (input.windows) setAvailability(db, staffId, input.windows);
    if (input.timeOff) setTimeOff(db, staffId, input.timeOff.date, input.timeOff.on, input.timeOff.reason);
  } catch (e) {
    return bad((e as Error).message);
  }
  return NextResponse.json({ availability: getAvailability(db, staffId), timeOff: listTimeOff(db, staffId) });
}
