// Notifications. Every message lands in the app (free, always on). Email is a
// copy on top, sent only when an email provider is set up, so running Rondo
// costs nothing until the owner chooses one. Text messages (SMS) cost money per
// message and are left out on purpose.
//
// Free email options when the pilot starts (no sign-up made yet):
//   Resend free tier, about 3,000 emails a month (100 a day).
//   Set RESEND_API_KEY and RONDO_EMAIL_FROM to turn it on.

import { randomUUID } from "node:crypto";
import type { DB } from "./db";

export type Notification = {
  id: string;
  staffId: string | null;
  subject: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

type Row = Record<string, unknown>;

// staffId null = the managers' inbox (shown on the schedule screen, emailed to every manager).
export function notify(db: DB, venueId: string, staffId: string | null, subject: string, body: string, now = new Date()) {
  let emailTo: string | null;
  if (staffId) {
    const r = db.prepare("SELECT email FROM staff WHERE id = ?").get(staffId) as Row | undefined;
    emailTo = r?.email == null ? null : String(r.email);
  } else {
    const rows = db
      .prepare("SELECT email FROM staff WHERE venue_id = ? AND role = 'Manager' AND active = 1 AND email IS NOT NULL")
      .all(venueId) as Row[];
    emailTo = rows.length ? rows.map((r) => String(r.email)).join(",") : null;
  }
  db.prepare(
    "INSERT INTO notifications (id, venue_id, staff_id, subject, body, created_at, email_to, email_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), venueId, staffId, subject, body, now.toISOString(), emailTo, emailTo ? "queued" : null);
}

export function listNotifications(db: DB, venueId: string, staffId: string | null, limit = 30): Notification[] {
  const rows = (
    staffId
      ? db.prepare("SELECT * FROM notifications WHERE venue_id = ? AND staff_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(venueId, staffId, limit)
      : db.prepare("SELECT * FROM notifications WHERE venue_id = ? AND staff_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?").all(venueId, limit)
  ) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    staffId: r.staff_id == null ? null : String(r.staff_id),
    subject: String(r.subject),
    body: String(r.body),
    createdAt: String(r.created_at),
    readAt: r.read_at == null ? null : String(r.read_at),
  }));
}

export type EmailSender = (to: string[], subject: string, text: string) => Promise<void>;

export function emailSenderFromEnv(env = process.env): EmailSender | null {
  const key = env.RESEND_API_KEY;
  const from = env.RONDO_EMAIL_FROM;
  if (!key || !from) return null;
  return async (to, subject, text) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) throw new Error(`Email provider said ${res.status}`);
  };
}

// Sends queued email copies. With no provider set up they are marked skipped;
// the in-app message is still there.
export async function flushEmail(db: DB, sender: EmailSender | null = emailSenderFromEnv()) {
  const rows = db.prepare("SELECT id, email_to, subject, body FROM notifications WHERE email_status = 'queued' LIMIT 50").all() as Row[];
  const mark = db.prepare("UPDATE notifications SET email_status = ? WHERE id = ?");
  for (const r of rows) {
    if (!sender) {
      mark.run("skipped", String(r.id));
      continue;
    }
    try {
      await sender(String(r.email_to).split(","), String(r.subject), `${r.body}\n\nOpen Rondo to see it or answer.`);
      mark.run("sent", String(r.id));
    } catch {
      mark.run("failed", String(r.id));
    }
  }
}
