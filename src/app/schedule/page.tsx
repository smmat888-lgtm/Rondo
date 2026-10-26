"use client";

import { useCallback, useEffect, useState } from "react";
import { api, dayLabel, timeIn, dateIn, type StaffLite } from "@/lib/client";
import { addDays, formatHours, minutesBetween } from "@/lib/time";
import { NOVA_SCOTIA } from "@/lib/rules";

type Shift = { id: string; staffId: string; role: string; startAt: string; endAt: string; note: string | null };
type Week = { weekStart: string; days: string[]; shifts: Shift[] };
type Draft = { staffId: string; date: string; start: string; end: string };

export default function SchedulePage() {
  const [tz, setTz] = useState("America/Halifax");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (date: string | null) => {
    const q = date ? `?week=${date}` : "";
    setWeek(await api<Week>(`/api/shifts${q}`));
  }, []);

  useEffect(() => {
    api<{ venue: { timezone: string }; staff: StaffLite[] }>("/api/staff").then((r) => {
      setTz(r.venue.timezone);
      setStaff(r.staff);
    });
  }, []);
  useEffect(() => {
    load(anchor).catch((e) => setError(e.message));
  }, [anchor, load]);

  async function save() {
    if (!draft) return;
    try {
      await api("/api/shifts", { method: "POST", body: JSON.stringify(draft) });
      setDraft(null);
      setError(null);
      await load(anchor);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    await api(`/api/shifts/${id}`, { method: "DELETE" });
    await load(anchor);
  }

  if (!week) return <p className="muted">Loading schedule...</p>;
  const today = dateIn(new Date().toISOString(), tz);
  const shiftsOn = (staffId: string, day: string) =>
    week.shifts.filter((s) => s.staffId === staffId && dateIn(s.startAt, tz) === day);
  const weekMinutes = (staffId: string) =>
    week.shifts.filter((s) => s.staffId === staffId).reduce((t, s) => t + minutesBetween(s.startAt, s.endAt), 0);
  const name = (id: string) => staff.find((s) => s.id === id)?.name ?? "";

  return (
    <>
      <h1>Schedule</h1>
      <p className="sub">
        Week of {dayLabel(week.weekStart)}. Hover a day and press + to add a shift. Anyone scheduled past 48 hours is
        highlighted, because overtime starts there in Nova Scotia.
      </p>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost" onClick={() => setAnchor(addDays(week.weekStart, -7))}>
          Previous week
        </button>
        <button className="btn ghost" onClick={() => setAnchor(null)}>
          This week
        </button>
        <button className="btn ghost" onClick={() => setAnchor(addDays(week.weekStart, 7))}>
          Next week
        </button>
      </div>
      {error && <div className="banner bad">{error}</div>}

      {draft && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row">
            <div>
              <b>{name(draft.staffId)}</b>
              <div className="muted">{dayLabel(draft.date)}</div>
            </div>
            <label>
              Start
              <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
            </label>
            <label>
              End
              <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
            </label>
            <button className="btn" onClick={save}>
              Add shift
            </button>
            <button className="btn ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          {draft.end < draft.start && <p className="muted">Ends after midnight, on the next day.</p>}
        </div>
      )}

      <div className="grid-wrap">
        <div className="grid">
          <div className="head">Staff</div>
          {week.days.map((d) => (
            <div key={d} className={`head ${d === today ? "today" : ""}`}>
              {dayLabel(d)}
            </div>
          ))}
          <div className="head">Week</div>

          {staff.map((s) => {
            const total = weekMinutes(s.id);
            return (
              <Row key={s.id}>
                <div className="who">
                  <b>{s.name}</b>
                  <span className="muted">{s.role}</span>
                </div>
                {week.days.map((d) => (
                  <div key={d} className="cell">
                    {shiftsOn(s.id, d).map((sh) => (
                      <div key={sh.id} className="chip">
                        <span>
                          {timeIn(sh.startAt, tz)} to {timeIn(sh.endAt, tz)}
                        </span>
                        <button aria-label="Remove shift" onClick={() => remove(sh.id)}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      className="add"
                      aria-label={`Add shift for ${s.name} on ${dayLabel(d)}`}
                      onClick={() => setDraft({ staffId: s.id, date: d, start: "17:00", end: "23:00" })}
                    >
                      +
                    </button>
                  </div>
                ))}
                <div className={`total ${total > NOVA_SCOTIA.overtimeAfterMinutes ? "over" : ""}`}>
                  {formatHours(total)}
                  {total > NOVA_SCOTIA.overtimeAfterMinutes && <div>Overtime</div>}
                </div>
              </Row>
            );
          })}
        </div>
      </div>
    </>
  );
}

// Grid rows are flat children of the CSS grid; this keeps the JSX readable.
function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
