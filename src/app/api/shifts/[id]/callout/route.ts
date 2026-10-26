import { NextResponse } from "next/server";
import { callOut } from "@/lib/automation";
import { getShift } from "@/lib/repo";
import { bad, body, currentVenue, runAutomation, staffFromPin } from "@/lib/server";

// "Can't make it": from the manager's grid, or from staff with their PIN.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { db, venue } = currentVenue();
  const input = await body<{ staffId?: string; pin?: string }>(req);
  let by: "staff" | "manager" = "manager";
  if (input?.staffId) {
    const staffId = staffFromPin(db, input);
    if (!staffId) return bad("Wrong PIN", 401);
    if (getShift(db, venue.id, id)?.staffId !== staffId) return bad("That isn't your shift", 403);
    by = "staff";
  }
  try {
    const open = callOut(db, venue, id, by);
    await runAutomation(db, venue);
    return NextResponse.json(open);
  } catch (e) {
    return bad((e as Error).message);
  }
}
