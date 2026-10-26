// Turns a staff member's raw punches into work sessions.
// Principle: never throw a punch away. Odd sequences (two clock-ins in a row,
// a break with no clock-in) are kept and flagged for the manager to fix.

export type PunchType = "in" | "break_start" | "break_end" | "out";

export type Punch = {
  id: string;
  staffId: string;
  type: PunchType;
  clientTime: string; // when the staff member tapped, from their device
};

export type Session = {
  start: string;
  end: string | null; // null = still clocked in, or forgot to clock out
  breaks: { start: string; end: string | null }[];
  paidMinutes: number;
  longestStretchMinutes: number; // longest run of work without a break of the required length
  flags: string[];
};

const ms = (iso: string) => Date.parse(iso);
const mins = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 60000);

export function buildSessions(punches: Punch[], requiredBreakMinutes = 30): Session[] {
  const sorted = [...punches].sort((a, b) => ms(a.clientTime) - ms(b.clientTime));
  const sessions: Session[] = [];
  let open: Session | null = null;

  for (const p of sorted) {
    if (p.type === "in") {
      if (open) {
        open.flags.push("Missing clock-out");
        sessions.push(open);
      }
      open = { start: p.clientTime, end: null, breaks: [], paidMinutes: 0, longestStretchMinutes: 0, flags: [] };
      continue;
    }
    if (!open) {
      // Punch without a clock-in: keep a zero-length session so it stays visible.
      sessions.push({
        start: p.clientTime,
        end: p.clientTime,
        breaks: [],
        paidMinutes: 0,
        longestStretchMinutes: 0,
        flags: [`"${label(p.type)}" with no clock-in`],
      });
      continue;
    }
    const lastBreak = open.breaks[open.breaks.length - 1];
    if (p.type === "break_start") {
      if (lastBreak && lastBreak.end === null) open.flags.push("Break started twice");
      else open.breaks.push({ start: p.clientTime, end: null });
    } else if (p.type === "break_end") {
      if (lastBreak && lastBreak.end === null) lastBreak.end = p.clientTime;
      else open.flags.push("Break ended without starting");
    } else {
      if (lastBreak && lastBreak.end === null) lastBreak.end = p.clientTime;
      open.end = p.clientTime;
      sessions.push(open);
      open = null;
    }
  }
  if (open) sessions.push(open);

  for (const s of sessions) finalize(s, requiredBreakMinutes);
  return sessions;
}

function finalize(s: Session, requiredBreakMinutes: number) {
  if (s.end === null) {
    s.paidMinutes = 0;
    return;
  }
  const breakMinutes = s.breaks.reduce((t, b) => t + (b.end ? mins(b.start, b.end) : 0), 0);
  s.paidMinutes = Math.max(0, mins(s.start, s.end) - breakMinutes);

  // Only breaks of the legal length reset the "hours in a row" counter.
  let stretchStart = s.start;
  let longest = 0;
  for (const b of s.breaks) {
    if (b.end && mins(b.start, b.end) >= requiredBreakMinutes) {
      longest = Math.max(longest, mins(stretchStart, b.start));
      stretchStart = b.end;
    }
  }
  s.longestStretchMinutes = Math.max(longest, mins(stretchStart, s.end));
}

export function label(t: PunchType): string {
  return { in: "Clock in", break_start: "Start break", break_end: "End break", out: "Clock out" }[t];
}

// Where someone stands right now, from their latest punch.
export function clockState(punches: Punch[]): "off" | "on" | "break" {
  const last = [...punches].sort((a, b) => ms(a.clientTime) - ms(b.clientTime)).at(-1);
  if (!last || last.type === "out") return "off";
  return last.type === "break_start" ? "break" : "on";
}
