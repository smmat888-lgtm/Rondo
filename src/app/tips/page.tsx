"use client";

import { useEffect, useState } from "react";
import { api, dayLabel } from "@/lib/client";
import { splitTips } from "@/lib/tips";
import { addDays, formatHours, formatMoney } from "@/lib/time";

type TipDay = {
  date: string;
  poolCents: number | null;
  shares: { staffId: string; name: string; minutes: number; amountCents: number }[];
};

export default function TipsPage() {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax" }).format(new Date()));
  const [day, setDay] = useState<TipDay | null>(null);
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setMsg(null);
    api<TipDay>(`/api/tips?date=${date}`).then((d) => {
      setDay(d);
      setAmount(d.poolCents == null ? "" : (d.poolCents / 100).toFixed(2));
    });
  }, [date]);

  const cents = Math.round(parseFloat(amount || "0") * 100);
  const valid = Number.isFinite(cents) && cents >= 0;
  // Live preview while typing; the server does the same split when saving.
  const preview = day && valid ? splitTips(cents, day.shares) : [];
  const names = new Map(day?.shares.map((s) => [s.staffId, s.name]));

  async function save() {
    try {
      const d = await api<TipDay>("/api/tips", { method: "POST", body: JSON.stringify({ date, amountCents: cents }) });
      setDay(d);
      setMsg({ ok: true, text: `Saved. ${formatMoney(cents)} split across ${d.shares.length} people.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <>
      <h1>Tips</h1>
      <p className="sub">
        Enter the night&apos;s tip pool. Rondo splits it by hours each tip-eligible person worked, to the cent. Managers
        are left out of the pool.
      </p>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost" onClick={() => setDate(addDays(date, -1))}>
          Previous day
        </button>
        <label>
          Day
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <button className="btn ghost" onClick={() => setDate(addDays(date, 1))}>
          Next day
        </button>
      </div>
      {msg && <div className={`banner ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="row">
          <label>
            Tip pool for {dayLabel(date)} (C$)
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </label>
          <button className="btn" onClick={save} disabled={!valid || !day?.shares.some((s) => s.minutes > 0)}>
            {day?.poolCents == null ? "Save split" : "Update split"}
          </button>
        </div>
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Who</th>
              <th>Hours</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {preview.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  Nobody tip-eligible has finished a shift on this day yet.
                </td>
              </tr>
            )}
            {preview.map((s) => (
              <tr key={s.staffId}>
                <td>{names.get(s.staffId)}</td>
                <td>{formatHours(s.minutes)}</td>
                <td>{formatMoney(s.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
