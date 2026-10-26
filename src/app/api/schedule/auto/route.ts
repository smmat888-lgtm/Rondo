import { NextResponse } from "next/server";
import { autoBuildWeek } from "@/lib/automation";
import { bad, body, currentVenue } from "@/lib/server";

// Auto-build a draft week from past weeks, availability and an optional labour budget.
export async function POST(req: Request) {
  const { db, venue } = currentVenue();
  const input = await body<{ week: string; budgetCents?: number | null; replace?: boolean }>(req);
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.week)) return bad("Expected { week: YYYY-MM-DD }");
  if (input.budgetCents != null && (!Number.isInteger(input.budgetCents) || input.budgetCents < 0)) return bad("Budget must be a whole number of cents");
  try {
    return NextResponse.json(autoBuildWeek(db, venue, input.week, { budgetCents: input.budgetCents, replace: input.replace }));
  } catch (e) {
    return bad((e as Error).message);
  }
}
