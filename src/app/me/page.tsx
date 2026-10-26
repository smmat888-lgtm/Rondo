"use client";

import { Fragment, useEffect, useState } from "react";
import { api, dateIn, dayLabel, timeIn, type StaffLite } from "@/lib/client";
import { label, type PunchType } from "@/lib/hours";
import { addDays, formatHours, formatMoney } from "@/lib/time";

type Session = { start: string; end: string | null; paidMinutes: number; flags: string[]; breaks: { start: string; end: string | null }[] };
type Window = { dow: number; start: string; end: string };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Week = {
  timezone: string;
  week: string[];
  staff: { name: string; role: string; hourlyRateCents: number };
  shifts: { id: string; startAt: string; endAt: string; note: string | null }[];
  offers: { offerId: string; role: string; startAt: string; endAt: string; expiresAt: string }[];
  notifications: { id: string; subject: string; body: string; createdAt: string }[];
  availability: Window[];
  timeOff: { date: string; reason: string | null }[];
  sessions: Session[];
  punches: { id: string; type: PunchType; clientTime: string; receiptCode: string; syncedLate: boolean; flag: string | null }[];
  pay: {
    paidMinutes: number;
    regularMinutes: number;
    overtimeMinutes: number;
    overtimePayCents: number;
    callInTopUpCents: number;
    grossCents: number;
    warnings: string[];
  };
  tipsCents: number;
};

export default function MyHoursPage() {
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [staffId, setStaffId] = useState("");
  const [pin, setPin] = useState("");
  const [anchor, setAnchor] = useState<string | undefined>();
  const [data, setData] = useState<Week | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api<{ staff: StaffLite[] }>("/api/staff").then((r) => setStaff(r.staff));
  }, []);

  async function act(url: string, payload: object, done: string) {
    try {
      await api(url, { method: "POST", body: JSON.stringify({ staffId, pin, ...payload }) });
      setNotice(done);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    }
    await load(anchor);
  }

  async function load(week?: string) {
    try {
      setData(await api<Week>("/api/me", { method: "POST", body: JSON.stringify({ staffId, pin, week }) }));
      setAnchor(week);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data) {
    return (
      <>
        <h1>My hours</h1>
        <p className="sub">See your shifts, every punch with its receipt, your hours and your tips.</p>
        {error && <div className="banner bad">{error}</div>}
        <form
          className="card row"
          style={{ maxWidth: 560 }}
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <label>
            Name
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} required>
              <option value="">Choose...</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            PIN
            <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value)} required />
          </label>
          <button className="btn">Show my hours</button>
        </form>
      </>
    );
  }

  const tz = data.timezone;
  const weekStart = data.week[0];
  return (
    <>
      <h1>{data.staff.name}</h1>
      <p className="sub">
        Week of {dayLabel(weekStart)} · {data.staff.role} · {formatMoney(data.staff.hourlyRateCents)}/h
      </p>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost" onClick={() => load(addDays(anchor ?? weekStart, -7))}>
          Previous week
        </button>
        <button className="btn ghost" onClick={() => load(undefined)}>
          This week
        </button>
        <button className="btn ghost" onClick={() => load(addDays(anchor ?? weekStart, 7))}>
          Next week
        </button>
        <button className="btn ghost" onClick={() => { setData(null); setPin(""); }}>
          Sign out
        </button>
      </div>

      {error && <div className="banner bad">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      {data.offers.map((o) => (
        <div key={o.offerId} className="card offer">
          <div>
            <b>Shift up for grabs</b>
            <div>
              {o.role}, {dayLabel(dateIn(o.startAt, tz))} {timeIn(o.startAt, tz)} to {timeIn(o.endAt, tz)}
            </div>
            <div className="muted">Answer by {timeIn(o.expiresAt, tz)}, first yes gets it.</div>
          </div>
          <div className="row">
            <button className="btn" onClick={() => act("/api/me/offer", { offerId: o.offerId, accept: true }, "It's yours. It's on your schedule now.")}>
              Take it
            </button>
            <button className="btn ghost" onClick={() => act("/api/me/offer", { offerId: o.offerId, accept: false }, "No problem. Rondo will ask someone else.")}>
              Can't
            </button>
          </div>
        </div>
      ))}

      <div className="cards">
        <Stat k="Hours worked" v={formatHours(data.pay.paidMinutes)} />
        <Stat k="Overtime (past 48h)" v={formatHours(data.pay.overtimeMinutes)} />
        <Stat k="Estimated pay" v={formatMoney(data.pay.grossCents)} />
        <Stat k="Tips" v={formatMoney(data.tipsCents)} />
      </div>
      {data.pay.callInTopUpCents > 0 && (
        <p className="muted">Includes {formatMoney(data.pay.callInTopUpCents)} for the 3-hour minimum on a short shift.</p>
      )}
      <p className="muted">Estimate before deductions. Your pay stub from the employer is the official record.</p>
      {data.pay.warnings.map((w, i) => (
        <div key={i} className="banner">
          {w}
        </div>
      ))}

      <h2>Scheduled</h2>
      {data.shifts.length === 0 ? (
        <p className="muted">No shifts this week yet. You'll see them once your manager publishes the schedule.</p>
      ) : (
        <table>
          <tbody>
            {data.shifts.map((s) => (
              <tr key={s.id}>
                <td>{dayLabel(dateIn(s.startAt, tz))}</td>
                <td>
                  {timeIn(s.startAt, tz)} to {timeIn(s.endAt, tz)}
                  {s.note && <div className="muted">{s.note}</div>}
                </td>
                <td style={{ textAlign: "right" }}>
                  {Date.parse(s.endAt) > Date.now() && (
                    <button
                      className="btn ghost"
                      onClick={() => {
                        if (confirm("Tell your manager you can't make this shift? Rondo will find cover."))
                          act(`/api/shifts/${s.id}/callout`, {}, "Your manager knows. Rondo is finding cover, so you don't have to.");
                      }}
                    >
                      Can't make it
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Worked</h2>
      {data.sessions.length === 0 ? (
        <p className="muted">No punches this week.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>In</th>
              <th>Out</th>
              <th>Breaks</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s, i) => (
              <tr key={i}>
                <td>{dayLabel(dateIn(s.start, tz))}</td>
                <td>{timeIn(s.start, tz)}</td>
                <td>{s.end ? timeIn(s.end, tz) : <span className="tag on">On the clock</span>}</td>
                <td>{s.breaks.length || "None"}</td>
                <td>
                  {formatHours(s.paidMinutes)}
                  {s.flags.map((f) => (
                    <div key={f} className="warn">
                      {f}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.notifications.length > 0 && (
        <>
          <h2>Messages</h2>
          <table>
            <tbody>
              {data.notifications.map((n) => (
                <tr key={n.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {dayLabel(dateIn(n.createdAt, tz))} {timeIn(n.createdAt, tz)}
                  </td>
                  <td>
                    <b>{n.subject}</b>
                    <div className="muted" style={{ whiteSpace: "pre-line" }}>
                      {n.body}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Availability
        initial={data.availability}
        timeOff={data.timeOff}
        save={(windows) => act("/api/me/availability", { windows }, "Availability saved. Rondo uses it for every schedule it builds.")}
        dayOff={(date, on) => act("/api/me/availability", { timeOff: { date, on } }, on ? "Day off requested." : "Day off removed.")}
      />

      <h2>Punch receipts</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Punch</th>
            <th>Receipt</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.punches.map((p) => (
            <tr key={p.id}>
              <td>
                {dayLabel(dateIn(p.clientTime, tz))} {timeIn(p.clientTime, tz)}
              </td>
              <td>{label(p.type)}</td>
              <td className="code">{p.receiptCode}</td>
              <td>
                {p.syncedLate && <span className="tag late">Sent after reconnecting</span>}
                {p.flag && <div className="warn">{p.flag}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Availability(props: {
  initial: Window[];
  timeOff: { date: string; reason: string | null }[];
  save: (w: Window[]) => void;
  dayOff: (date: string, on: boolean) => void;
}) {
  // No rows saved means "any time", shown as every day ticked 00:00 to 00:00.
  const start = (dow: number) => props.initial.find((w) => w.dow === dow);
  const [rows, setRows] = useState(() =>
    DAYS.map((_, dow) => ({
      on: props.initial.length === 0 || !!start(dow),
      start: start(dow)?.start ?? "00:00",
      end: start(dow)?.end ?? "00:00",
    })),
  );
  const [date, setDate] = useState("");
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const anyTime = rows.every((r) => r.on && r.start === "00:00" && r.end === "00:00");

  return (
    <>
      <h2>When I can work</h2>
      <p className="muted">Rondo only schedules you, and only offers you open shifts, inside these times. 00:00 to 00:00 means all day.</p>
      <div className="card avail">
        {rows.map((r, i) => (
          <Fragment key={i}>
            <b>{DAYS[i]}</b>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} /> {r.on ? "Available" : "Not available"}
            </label>
            <span className="row">
              {r.on && (
                <>
                  <input type="time" value={r.start} onChange={(e) => set(i, { start: e.target.value })} />
                  <span className="muted">to</span>
                  <input type="time" value={r.end} onChange={(e) => set(i, { end: e.target.value })} />
                </>
              )}
            </span>
          </Fragment>
        ))}
        <span />
        <button className="btn" onClick={() => props.save(anyTime ? [] : rows.flatMap((r, dow) => (r.on ? [{ dow, start: r.start, end: r.end }] : [])))}>
          Save availability
        </button>
      </div>

      <h2>Days off</h2>
      <div className="row">
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button className="btn ghost" disabled={!date} onClick={() => props.dayOff(date, true)}>
          Ask for this day off
        </button>
      </div>
      {props.timeOff.map((t) => (
        <div key={t.date} className="row" style={{ marginTop: 8 }}>
          <span>
            {t.date}
            {t.reason && <span className="muted"> · {t.reason}</span>}
          </span>
          <button className="btn ghost" onClick={() => props.dayOff(t.date, false)}>
            Remove
          </button>
        </div>
      ))}
    </>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="card stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
