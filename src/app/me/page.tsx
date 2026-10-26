"use client";

import { useEffect, useState } from "react";
import { api, dateIn, dayLabel, timeIn, type StaffLite } from "@/lib/client";
import { label, type PunchType } from "@/lib/hours";
import { addDays, formatHours, formatMoney } from "@/lib/time";

type Session = { start: string; end: string | null; paidMinutes: number; flags: string[]; breaks: { start: string; end: string | null }[] };
type Week = {
  timezone: string;
  week: string[];
  staff: { name: string; role: string; hourlyRateCents: number };
  shifts: { id: string; startAt: string; endAt: string }[];
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

  useEffect(() => {
    api<{ staff: StaffLite[] }>("/api/staff").then((r) => setStaff(r.staff));
  }, []);

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
        <p className="muted">No shifts scheduled this week.</p>
      ) : (
        <table>
          <tbody>
            {data.shifts.map((s) => (
              <tr key={s.id}>
                <td>{dayLabel(dateIn(s.startAt, tz))}</td>
                <td>
                  {timeIn(s.startAt, tz)} to {timeIn(s.endAt, tz)}
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

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="card stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
