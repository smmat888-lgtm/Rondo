"use client";

import { useCallback, useEffect, useState } from "react";
import { api, dayLabel, timeIn, dateIn, type StaffLite } from "@/lib/client";
import { addDays, formatHours, formatMoney, minutesBetween } from "@/lib/time";
import { NOVA_SCOTIA } from "@/lib/rules";

type Shift = { id: string; staffId: string; role: string; startAt: string; endAt: string; note: string | null };
type OpenShift = {
  id: string;
  role: string;
  startAt: string;
  endAt: string;
  status: "draft" | "open" | "filled" | "unfilled";
  reason: string | null;
  filledBy: string | null;
  offers: { staffId: string; status: string }[];
};
type Note = { id: string; subject: string; body: string; createdAt: string };
type Week = { weekStart: string; days: string[]; publishedAt: string | null; shifts: Shift[]; openShifts: OpenShift[]; inbox: Note[] };
type Draft = { staffId: string; date: string; start: string; end: string; role: string };
type Issue = { level: "block" | "warn" | "info"; message: string; extraCostCents?: number };
type Built = { created: number; open: unknown[]; trimmed: unknown[]; costCents: number; budgetCents: number | null; notes: string[] };

export default function SchedulePage() {
  const [tz, setTz] = useState("America/Halifax");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const [built, setBuilt] = useState<Built | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState(false);

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
    setBuilt(null);
    setIssues(null);
    // Refresh so open-shift offers and answers show up without reloading.
    const t = setInterval(() => load(anchor).catch(() => {}), 30000);
    return () => clearInterval(t);
  }, [anchor, load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load(anchor).catch(() => {});
    }
  }

  async function save() {
    if (!draft) return;
    await run(async () => {
      if (draft.staffId) await api("/api/shifts", { method: "POST", body: JSON.stringify(draft) });
      else await api("/api/open-shifts", { method: "POST", body: JSON.stringify(draft) });
      setDraft(null);
    });
  }

  const remove = (id: string) => run(async () => void (await api(`/api/shifts/${id}`, { method: "DELETE" })));
  const findCover = (id: string) => run(async () => void (await api(`/api/shifts/${id}/callout`, { method: "POST", body: "{}" })));

  function autoBuild(replace: boolean) {
    if (!week) return;
    const dollars = budget.trim() ? Math.round(Number(budget) * 100) : null;
    if (dollars != null && !Number.isFinite(dollars)) return setError("Budget must be a number");
    run(async () => {
      setIssues(null);
      setBuilt(await api<Built>("/api/schedule/auto", { method: "POST", body: JSON.stringify({ week: week.weekStart, budgetCents: dollars, replace }) }));
    });
  }

  const check = () => run(async () => setIssues((await api<{ issues: Issue[] }>(`/api/schedule/check?week=${week!.weekStart}`)).issues));

  function publish(confirmWarnings: boolean) {
    run(async () => {
      const res = await fetch("/api/schedule/publish", { method: "POST", body: JSON.stringify({ week: week!.weekStart, confirmWarnings }) });
      const r = (await res.json()) as { published: boolean; issues: Issue[]; breaksAdded: number };
      setIssues(r.published ? null : r.issues);
      setBuilt(null);
      if (r.published) setError(null);
    });
  }

  if (!week) return <p className="muted">Loading schedule...</p>;
  const today = dateIn(new Date().toISOString(), tz);
  const now = Date.now();
  const shiftsOn = (staffId: string, day: string) => week.shifts.filter((s) => s.staffId === staffId && dateIn(s.startAt, tz) === day);
  const openOn = (day: string) => week.openShifts.filter((o) => dateIn(o.startAt, tz) === day);
  const weekMinutes = (staffId: string) =>
    week.shifts.filter((s) => s.staffId === staffId).reduce((t, s) => t + minutesBetween(s.startAt, s.endAt), 0);
  const name = (id: string | null) => staff.find((s) => s.id === id)?.name ?? "";
  const first = (n: string) => n.split(" ")[0];
  const roles = [...new Set(staff.map((s) => s.role))];
  const published = week.publishedAt != null;
  const blocked = issues?.some((i) => i.level === "block");
  const warned = issues?.some((i) => i.level === "warn");

  return (
    <>
      <h1>
        Schedule <span className={`tag ${published ? "on" : "break"}`}>{published ? "Published" : "Draft"}</span>
      </h1>
      <p className="sub">
        Week of {dayLabel(week.weekStart)}.{" "}
        {published
          ? "Staff can see this week. If someone can't make a shift, press ↺ and Rondo finds cover."
          : "Let Rondo build the week from your last four, then check and publish. Staff see it only after you publish."}
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

      {!published && (
        <div className="card row" style={{ marginBottom: 14 }}>
          <label>
            Labour budget for the week (optional)
            <input inputMode="decimal" placeholder="e.g. 4200" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 160 }} />
          </label>
          {week.shifts.length === 0 ? (
            <button className="btn" disabled={busy} onClick={() => autoBuild(false)}>
              Auto-build this week
            </button>
          ) : (
            <button className="btn ghost" disabled={busy} onClick={() => autoBuild(true)}>
              Rebuild draft
            </button>
          )}
          <button className="btn" disabled={busy || week.shifts.length === 0} onClick={check}>
            Check and publish
          </button>
        </div>
      )}
      {error && <div className="banner bad">{error}</div>}

      {built && (
        <div className="banner ok">
          <b>
            Draft ready: {built.created} shifts, {formatMoney(built.costCents)} in wages
            {built.budgetCents != null && ` (budget ${formatMoney(built.budgetCents)})`}.
          </b>
          {built.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      {issues && (
        <div className="card" style={{ marginBottom: 14 }}>
          <b>{blocked ? "Fix these before publishing" : warned ? "Check these, then publish" : "All rules pass"}</b>
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={n} className={i.level === "block" ? "err" : i.level === "warn" ? "warn" : "muted"}>
                {i.message}
              </li>
            ))}
          </ul>
          {!blocked && (
            <button className="btn" disabled={busy} onClick={() => publish(true)}>
              {warned ? "Publish anyway" : "Publish and notify staff"}
            </button>
          )}
        </div>
      )}

      {draft && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row">
            <div>
              <b>{draft.staffId ? name(draft.staffId) : "Open shift"}</b>
              <div className="muted">{dayLabel(draft.date)}</div>
            </div>
            {!draft.staffId && (
              <label>
                Role
                <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                  {roles.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Start
              <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
            </label>
            <label>
              End
              <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
            </label>
            <button className="btn" onClick={save}>
              {draft.staffId ? "Add shift" : "Post open shift"}
            </button>
            <button className="btn ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          {draft.end < draft.start && <p className="muted">Ends after midnight, on the next day.</p>}
          {!draft.staffId && <p className="muted">Rondo offers it to staff who can take it without overtime or clashes, best fit first.</p>}
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
                      <div key={sh.id} className="chip" title={sh.note ?? undefined}>
                        <span>
                          {timeIn(sh.startAt, tz)} to {timeIn(sh.endAt, tz)}
                          {sh.note && <small className="status">break planned</small>}
                        </span>
                        <span>
                          {published && Date.parse(sh.endAt) > now && (
                            <button aria-label="Can't make it: find cover" title="Can't make it: find cover" onClick={() => findCover(sh.id)}>
                              ↺
                            </button>
                          )}
                          <button aria-label="Remove shift" onClick={() => remove(sh.id)}>
                            ×
                          </button>
                        </span>
                      </div>
                    ))}
                    <button
                      className="add"
                      aria-label={`Add shift for ${s.name} on ${dayLabel(d)}`}
                      onClick={() => setDraft({ staffId: s.id, date: d, start: "17:00", end: "23:00", role: s.role })}
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

          <div className="who">
            <b>Open shifts</b>
            <span className="muted">Rondo fills these</span>
          </div>
          {week.days.map((d) => (
            <div key={d} className="cell">
              {openOn(d).map((o) => (
                <div key={o.id} className={`chip open ${o.status}`} title={o.reason ?? undefined}>
                  <span>
                    {o.role} {timeIn(o.startAt, tz)} to {timeIn(o.endAt, tz)}
                    <small className="status">{openStatus(o, (id) => first(name(id)))}</small>
                  </span>
                </div>
              ))}
              <button
                className="add"
                aria-label={`Post an open shift on ${dayLabel(d)}`}
                onClick={() => setDraft({ staffId: "", date: d, start: "17:00", end: "23:00", role: roles[0] ?? "Server" })}
              >
                +
              </button>
            </div>
          ))}
          <div />
        </div>
      </div>

      <h2>What Rondo did</h2>
      {week.inbox.length === 0 ? (
        <p className="muted">Nothing yet. Call-outs, pick-ups and published schedules show up here.</p>
      ) : (
        <table>
          <tbody>
            {week.inbox.map((n) => (
              <tr key={n.id}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>
                  {dayLabel(dateIn(n.createdAt, tz))} {timeIn(n.createdAt, tz)}
                </td>
                <td>
                  <b>{n.subject}</b>
                  <div className="muted">{n.body}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function openStatus(o: OpenShift, name: (id: string | null) => string): string {
  if (o.status === "filled") return `Filled by ${name(o.filledBy)}`;
  if (o.status === "unfilled") return "Nobody available";
  if (o.status === "draft") return "Offered after publish";
  const pending = o.offers.filter((x) => x.status === "pending").map((x) => name(x.staffId));
  return pending.length ? `Asking ${pending.join(", ")}` : "Finding cover";
}

// Grid rows are flat children of the CSS grid; this keeps the JSX readable.
function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
