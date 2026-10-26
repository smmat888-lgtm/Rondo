import { NextResponse } from "next/server";
import { publishWeek } from "@/lib/automation";
import { bad, body, currentVenue, runAutomation } from "@/lib/server";

// Checks the rules, plans breaks, publishes and tells every staff member.
export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ week: string; confirmWarnings?: boolean }>(req);
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.week)) return bad("Expected { week: YYYY-MM-DD }");
  const result = publishWeek(db, venue, input.week, { confirmWarnings: input.confirmWarnings });
  await runAutomation(db, venue);
  return NextResponse.json(result, { status: result.published ? 200 : 409 });
}
