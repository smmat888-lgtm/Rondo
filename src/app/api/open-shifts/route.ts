import { NextResponse } from "next/server";
import { postOpenShift } from "@/lib/automation";
import { bad, body, currentVenue, runAutomation } from "@/lib/server";

// Manager posts a shift with nobody on it. Rondo offers it to eligible staff.
export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ date: string; start: string; end: string; role: string }>(req);
  if (!input) return bad("Expected JSON");
  try {
    const open = postOpenShift(db, venue, input);
    await runAutomation(db, venue);
    return NextResponse.json(open, { status: 201 });
  } catch (e) {
    return bad((e as Error).message);
  }
}
