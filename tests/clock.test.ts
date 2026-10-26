import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_VENUE, openDb, seedDemo, type DB } from "../src/lib/db";
import { PunchQueue, type KeyValueStore, type QueuedPunch } from "../src/lib/offlineQueue";
import { receiptCode } from "../src/lib/receipt";
import * as repo from "../src/lib/repo";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  seedDemo(db);
});

const punch = (id: string, type: QueuedPunch["type"], clientTime: string, pin = "1234") => ({
  id,
  staffId: "staff-maria",
  type,
  clientTime,
  pin,
});

describe("time clock", () => {
  it("saves a punch and returns a receipt", () => {
    const now = new Date("2026-11-06T21:00:00Z");
    const r = repo.recordPunch(db, DEMO_VENUE, punch("a1", "in", now.toISOString()), now);
    expect(r.status).toBe("saved");
    if (r.status !== "rejected") expect(r.receiptCode).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  });

  it("the receipt made on the device matches the server's", () => {
    const now = new Date("2026-11-06T21:00:00Z");
    const input = punch("a2", "in", now.toISOString());
    const r = repo.recordPunch(db, DEMO_VENUE, input, now);
    expect(r.status !== "rejected" && r.receiptCode).toBe(receiptCode(input));
  });

  it("stores a punch sent twice only once", () => {
    const now = new Date("2026-11-06T21:00:00Z");
    const first = repo.recordPunch(db, DEMO_VENUE, punch("a3", "in", now.toISOString()), now);
    const again = repo.recordPunch(db, DEMO_VENUE, punch("a3", "in", now.toISOString()), now);
    expect(again.status).toBe("duplicate");
    expect(again.status !== "rejected" && again.receiptCode).toBe(first.status !== "rejected" && first.receiptCode);
    expect(repo.listPunches(db, "staff-maria", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toHaveLength(1);
  });

  it("rejects a wrong PIN", () => {
    const r = repo.recordPunch(db, DEMO_VENUE, punch("a4", "in", "2026-11-06T21:00:00Z", "0000"));
    expect(r).toEqual({ status: "rejected", reason: "Wrong PIN" });
  });

  it("keeps the real punch time for an offline punch that syncs later", () => {
    const tapped = "2026-11-06T21:00:00.000Z";
    const synced = new Date("2026-11-06T21:45:00Z");
    const r = repo.recordPunch(db, DEMO_VENUE, punch("a5", "in", tapped), synced);
    expect(r.status !== "rejected" && r.syncedLate).toBe(true);
    expect(repo.listPunches(db, "staff-maria", "2026-11-06T00:00:00Z", "2026-11-07T00:00:00Z")[0].clientTime).toBe(tapped);
  });

  it("shows who is on the clock", () => {
    const now = new Date("2026-11-06T21:00:00Z");
    repo.recordPunch(db, DEMO_VENUE, punch("a6", "in", "2026-11-06T20:00:00Z"), now);
    expect(repo.currentClockStates(db, DEMO_VENUE, now)["staff-maria"]).toBe("on");
    expect(repo.currentClockStates(db, DEMO_VENUE, now)["staff-jamal"]).toBe("off");
  });
});

describe("offline punch queue", () => {
  const memory = (): KeyValueStore => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };
  const q = (id: string): QueuedPunch => ({ ...punch(id, "in", "2026-11-06T21:00:00Z"), receiptCode: "X" });

  it("keeps punches while the network is down and sends them when it is back", async () => {
    let online = false;
    const sent: string[] = [];
    const queue = new PunchQueue(memory(), async (p) => {
      if (!online) return "failed";
      sent.push(p.id);
      return "saved";
    });
    queue.add(q("1"));
    queue.add(q("2"));
    expect((await queue.flush()).remaining).toBe(2);
    online = true;
    expect(await queue.flush()).toEqual({ sent: 2, rejected: [], remaining: 0 });
    expect(sent).toEqual(["1", "2"]);
  });

  it("reports punches the server refuses instead of retrying forever", async () => {
    const queue = new PunchQueue(memory(), async () => "rejected");
    queue.add(q("1"));
    const r = await queue.flush();
    expect(r.rejected.map((x) => x.id)).toEqual(["1"]);
    expect(r.remaining).toBe(0);
  });
});

describe("schedule", () => {
  it("creates a shift past midnight in Halifax time", () => {
    const venue = repo.getVenue(db, DEMO_VENUE);
    const s = repo.createShift(db, venue, { staffId: "staff-maria", date: "2026-11-06", start: "18:00", end: "02:00" });
    // Daylight time ends Nov 1, 2026, so Nov 6 is Atlantic Standard Time (UTC-4).
    expect(s.startAt).toBe("2026-11-06T22:00:00.000Z");
    expect(s.endAt).toBe("2026-11-07T06:00:00.000Z");
    const week = repo.weekRange(venue, "2026-11-06");
    expect(week.start).toBe("2026-11-02");
    expect(repo.listShifts(db, DEMO_VENUE, week.fromUtc, week.toUtc)).toHaveLength(1);
  });

  it("handles summer time (ADT, UTC-3)", () => {
    const venue = repo.getVenue(db, DEMO_VENUE);
    const s = repo.createShift(db, venue, { staffId: "staff-maria", date: "2026-07-10", start: "17:00", end: "23:00" });
    expect(s.startAt).toBe("2026-07-10T20:00:00.000Z");
  });

  it("refuses a shift for someone not on staff", () => {
    const venue = repo.getVenue(db, DEMO_VENUE);
    expect(() => repo.createShift(db, venue, { staffId: "nobody", date: "2026-11-06", start: "18:00", end: "22:00" })).toThrow();
  });
});

describe("tips and my hours", () => {
  it("splits a night's tips across tip-eligible staff by hours and shows it in My hours", () => {
    const venue = repo.getVenue(db, DEMO_VENUE);
    const now = new Date("2026-11-08T12:00:00Z");
    // Halifax Nov 6, 17:00-23:00 local = 21:00-03:00 UTC
    repo.recordPunch(db, DEMO_VENUE, { id: "m1", staffId: "staff-maria", type: "in", clientTime: "2026-11-06T21:00:00Z", pin: "1234" }, now);
    repo.recordPunch(db, DEMO_VENUE, { id: "m2", staffId: "staff-maria", type: "out", clientTime: "2026-11-07T03:00:00Z", pin: "1234" }, now);
    repo.recordPunch(db, DEMO_VENUE, { id: "j1", staffId: "staff-jamal", type: "in", clientTime: "2026-11-06T21:00:00Z", pin: "1234" }, now);
    repo.recordPunch(db, DEMO_VENUE, { id: "j2", staffId: "staff-jamal", type: "out", clientTime: "2026-11-07T00:00:00Z", pin: "1234" }, now);
    // Manager (not tip-eligible) also worked
    repo.recordPunch(db, DEMO_VENUE, { id: "v1", staffId: "staff-ava", type: "in", clientTime: "2026-11-06T21:00:00Z", pin: "1234" }, now);
    repo.recordPunch(db, DEMO_VENUE, { id: "v2", staffId: "staff-ava", type: "out", clientTime: "2026-11-07T03:00:00Z", pin: "1234" }, now);

    const day = repo.saveTipPool(db, venue, "2026-11-06", 45000);
    expect(day.shares.map((s) => [s.staffId, s.amountCents])).toEqual([
      ["staff-maria", 30000],
      ["staff-jamal", 15000],
    ]);

    const me = repo.myWeek(db, venue, "staff-maria", "2026-11-06");
    expect(me.pay.paidMinutes).toBe(360);
    expect(me.pay.grossCents).toBe(6 * 1800);
    expect(me.tipsCents).toBe(30000);
    expect(me.punches.every((p) => p.receiptCode.length === 9)).toBe(true);
  });
});
