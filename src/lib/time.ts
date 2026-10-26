// Date helpers. Timestamps are stored as UTC ISO strings; everything shown to
// people is converted to the venue's time zone (America/Halifax for now).

export type LocalParts = { date: string; time: string };

export function localParts(iso: string, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function offsetMs(utcMs: number, tz: string): number {
  const { date, time } = localParts(new Date(utcMs).toISOString(), tz);
  const asIfUtc = Date.parse(`${date}T${time}:00Z`);
  return asIfUtc - Math.floor(utcMs / 60000) * 60000;
}

// "2026-11-06" + "17:00" in Halifax -> UTC ISO string.
export function zonedToUtc(date: string, time: string, tz: string): string {
  const guess = Date.parse(`${date}T${time}:00Z`);
  let utc = guess - offsetMs(guess, tz);
  // Second pass corrects guesses that land on the other side of a DST switch.
  utc = guess - offsetMs(utc, tz);
  return new Date(utc).toISOString();
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// weekStartDay: 0 = Sunday, 1 = Monday, ...
export function startOfWeek(date: string, weekStartDay: number): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow - weekStartDay + 7) % 7));
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m ? ` ${String(m).padStart(2, "0")}m` : ""}`;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
}
