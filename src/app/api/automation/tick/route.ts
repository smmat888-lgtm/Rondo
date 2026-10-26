import { NextResponse } from "next/server";
import { bad, currentVenue, runAutomation } from "@/lib/server";

export const dynamic = "force-dynamic";

// For a free scheduled ping once Rondo is hosted (for example a Cloudflare cron
// trigger every 5 minutes), so offers move on even when nobody has the app open.
// Set RONDO_CRON_SECRET and send it as "Authorization: Bearer <secret>".
export async function POST(req: Request) {
  const secret = process.env.RONDO_CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return bad("Not allowed", 401);
  const { db, venue } = currentVenue();
  await runAutomation(db, venue);
  return NextResponse.json({ ok: true });
}
