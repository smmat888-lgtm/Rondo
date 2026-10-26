"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, timeIn, type StaffLite } from "@/lib/client";
import { label, type PunchType } from "@/lib/hours";
import { PunchQueue, type QueuedPunch } from "@/lib/offlineQueue";
import { receiptCode } from "@/lib/receipt";

type Step =
  | { kind: "pick" }
  | { kind: "pin"; staff: StaffLite; pin: string }
  | { kind: "action"; staff: StaffLite; pin: string }
  | { kind: "done"; staff: StaffLite; punch: QueuedPunch; synced: boolean };

const NEXT: Record<StaffLite["state"], PunchType[]> = {
  off: ["in"],
  on: ["break_start", "out"],
  break: ["break_end", "out"],
};
const AFTER: Record<PunchType, StaffLite["state"]> = { in: "on", break_start: "break", break_end: "on", out: "off" };

async function sendPunch(p: QueuedPunch): Promise<"saved" | "rejected" | "failed"> {
  try {
    const res = await fetch("/api/punches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
    if (res.ok) return "saved";
    return res.status === 422 ? "rejected" : "failed";
  } catch {
    return "failed";
  }
}

export default function ClockPage() {
  const [tz, setTz] = useState("America/Halifax");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const queue = useMemo(
    () => (typeof window === "undefined" ? null : new PunchQueue(window.localStorage, sendPunch)),
    [],
  );

  const flush = useCallback(async () => {
    if (!queue) return;
    const r = await queue.flush();
    setPending(r.remaining);
    if (r.rejected.length) {
      setProblem(
        `${r.rejected.length} punch(es) were refused by the server (usually a wrong PIN). Tell a manager so they can add the time by hand.`,
      );
    }
    return r;
  }, [queue]);

  useEffect(() => {
    api<{ venue: { timezone: string }; staff: StaffLite[] }>("/api/staff")
      .then((r) => {
        setTz(r.venue.timezone);
        setStaff(r.staff);
      })
      .catch(() => setOnline(false));
    setOnline(navigator.onLine);
    setPending(queue?.pending().length ?? 0);
    flush();
    const up = () => {
      setOnline(true);
      flush();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const timer = setInterval(flush, 30_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(timer);
    };
  }, [flush, queue]);

  async function punch(s: StaffLite, pin: string, type: PunchType) {
    if (!queue) return;
    const base = { id: crypto.randomUUID(), staffId: s.id, type, clientTime: new Date().toISOString(), pin };
    const p: QueuedPunch = { ...base, receiptCode: receiptCode(base) };
    // Saved on this device first, so it can't be lost if the network drops mid-tap.
    queue.add(p);
    const r = await flush();
    if (r?.rejected.some((q) => q.id === p.id)) {
      setProblem("That PIN didn't match. Try again.");
      setStep({ kind: "pin", staff: s, pin: "" });
      return;
    }
    const synced = !!r && !queue.pending().some((q) => q.id === p.id);
    setStaff((list) => list.map((x) => (x.id === s.id ? { ...x, state: AFTER[type] } : x)));
    setStep({ kind: "done", staff: s, punch: p, synced });
  }

  return (
    <>
      <h1>Time clock</h1>
      <div className="status" style={{ marginBottom: 14 }}>
        <span className={`dot ${online ? "" : "off"}`} />
        {online ? "Online" : "Offline: punches are saved on this device and sent when the connection is back"}
        {pending > 0 && <span className="tag late">{pending} waiting to sync</span>}
      </div>
      {problem && (
        <div className="banner bad" onClick={() => setProblem(null)}>
          {problem}
        </div>
      )}

      {step.kind === "pick" && (
        <>
          <p className="sub">Tap your name.</p>
          <div className="staff-pick">
            {staff.map((s) => (
              <button key={s.id} onClick={() => setStep({ kind: "pin", staff: s, pin: "" })}>
                {s.name}
                <div style={{ marginTop: 6 }}>
                  <span className={`tag ${s.state}`}>
                    {s.state === "on" ? "On the clock" : s.state === "break" ? "On break" : "Off"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {step.kind === "pin" && (
        <PinPad
          name={step.staff.name}
          pin={step.pin}
          onChange={(pin) =>
            pin.length === 4 ? setStep({ kind: "action", staff: step.staff, pin }) : setStep({ ...step, pin })
          }
          onCancel={() => setStep({ kind: "pick" })}
        />
      )}

      {step.kind === "action" && (
        <div className="card" style={{ maxWidth: 420 }}>
          <h2 style={{ marginTop: 0 }}>{step.staff.name}</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {NEXT[step.staff.state].map((t) => (
              <button
                key={t}
                className={`btn big ${t === "out" ? "danger" : ""}`}
                onClick={() => punch(step.staff, step.pin, t)}
              >
                {label(t)}
              </button>
            ))}
            <button className="btn ghost" onClick={() => setStep({ kind: "pick" })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step.kind === "done" && (
        <div className="card receipt">
          <div className="muted">
            {label(step.punch.type)} for {step.staff.name} at {timeIn(step.punch.clientTime, tz)}
          </div>
          <span className="code">{step.punch.receiptCode}</span>
          {step.synced ? (
            <div className="banner ok">Saved. This is your punch receipt.</div>
          ) : (
            <div className="banner">
              Saved on this device. It will be sent automatically. Your time counts from when you tapped.
            </div>
          )}
          <p className="muted">You can see every punch and its receipt under My hours.</p>
          <button className="btn" onClick={() => setStep({ kind: "pick" })}>
            Done
          </button>
        </div>
      )}
    </>
  );
}

function PinPad(props: { name: string; pin: string; onChange: (pin: string) => void; onCancel: () => void }) {
  const press = (k: string) => props.onChange(k === "<" ? props.pin.slice(0, -1) : (props.pin + k).slice(0, 4));
  return (
    <div className="card" style={{ maxWidth: 360 }}>
      <h2 style={{ marginTop: 0 }}>Hi {props.name.split(" ")[0]}, enter your PIN</h2>
      <div className="dots">{"•".repeat(props.pin.length) || " "}</div>
      <div className="pinpad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "<", "0"].map((k) => (
          <button key={k} onClick={() => press(k)} aria-label={k === "<" ? "Delete" : k}>
            {k === "<" ? "⌫" : k}
          </button>
        ))}
        <button onClick={props.onCancel} style={{ fontSize: 15 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
