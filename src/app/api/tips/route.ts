import { NextResponse } from "next/server";
import { getTipDay, saveTipPool } from "@/lib/repo";
import { bad, body, currentVenue, todayIn } from "@/lib/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const { db, venue } = currentVenue();
  const date = new URL(req.url).searchParams.get("date") ?? todayIn(venue.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("date must be YYYY-MM-DD");
  return NextResponse.json(getTipDay(db, venue, date));
}

export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ date: string; amountCents: number }>(req);
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return bad("Expected { date, amountCents }");
  try {
    return NextResponse.json(saveTipPool(db, venue, input.date, input.amountCents));
  } catch (e) {
    return bad((e as Error).message);
  }
}
