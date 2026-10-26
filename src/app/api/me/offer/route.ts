import { NextResponse } from "next/server";
import { answerOffer } from "@/lib/automation";
import { bad, body, currentVenue, runAutomation, staffFromPin } from "@/lib/server";

export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ staffId: string; pin: string; offerId: string; accept: boolean }>(req);
  const staffId = staffFromPin(db, input);
  if (!input || !staffId) return bad("Wrong PIN", 401);
  const result = answerOffer(db, venue, input.offerId, staffId, input.accept === true);
  await runAutomation(db, venue);
  return result.ok ? NextResponse.json(result) : bad(result.reason, 409);
}
