import { NextResponse } from "next/server";
import type { PunchType } from "@/lib/hours";
import { recordPunch } from "@/lib/repo";
import { bad, body, currentVenue } from "@/lib/server";

// Safe to call more than once with the same punch id: the punch is stored once.
export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ id: string; staffId: string; type: PunchType; clientTime: string; pin: string }>(req);
  if (!input) return bad("Expected JSON");
  const result = recordPunch(db, venue.id, input);
  return NextResponse.json(result, { status: result.status === "rejected" ? 422 : 200 });
}
