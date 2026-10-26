import { NextResponse } from "next/server";
import { deleteShift } from "@/lib/repo";
import { bad, currentVenue } from "@/lib/server";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { db, venue } = currentVenue();
  return deleteShift(db, venue.id, id) ? NextResponse.json({ ok: true }) : bad("Shift not found", 404);
}
