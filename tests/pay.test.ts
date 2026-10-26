import { describe, expect, it } from "vitest";
import { buildSessions, type Punch } from "../src/lib/hours";
import { weekPay } from "../src/lib/pay";
import { NOVA_SCOTIA } from "../src/lib/rules";

let n = 0;
const p = (type: Punch["type"], clientTime: string): Punch => ({ id: `p${n++}`, staffId: "s1", type, clientTime });
const shift = (day: string, from: string, to: string) => [p("in", `${day}T${from}:00Z`), p("out", `${day}T${to}:00Z`)];

describe("Nova Scotia pay rules", () => {
  it("pays straight time up to 48 hours", () => {
    // 6 shifts of 8h = 48h exactly, no overtime
    const punches = ["01", "02", "03", "04", "05", "06"].flatMap((d) => shift(`2026-11-${d}`, "10:00", "18:00"));
    const pay = weekPay(buildSessions(punches), 2000, NOVA_SCOTIA);
    expect(pay.paidMinutes).toBe(48 * 60);
    expect(pay.overtimeMinutes).toBe(0);
    expect(pay.grossCents).toBe(48 * 2000);
  });

  it("pays time and a half on hours past 48 in the week", () => {
    // 5 x 10h = 50h, so 2h of overtime at $30
    const punches = ["01", "02", "03", "04", "05"].flatMap((d) => shift(`2026-11-${d}`, "08:00", "18:00"));
    const pay = weekPay(buildSessions(punches), 2000, NOVA_SCOTIA);
    expect(pay.regularMinutes).toBe(48 * 60);
    expect(pay.overtimeMinutes).toBe(120);
    expect(pay.overtimePayCents).toBe(6000);
    expect(pay.grossCents).toBe(48 * 2000 + 6000);
  });

  it("tops up a short call-in to 3 hours at minimum wage", () => {
    // Sent home after 1.5h at $17: earned $25.50, owed 3h x $17 = $51
    const pay = weekPay(buildSessions(shift("2026-11-02", "17:00", "18:30")), 1700, NOVA_SCOTIA);
    expect(pay.callInTopUpCents).toBe(2550);
    expect(pay.grossCents).toBe(5100);
  });

  it("does not top up when hours worked already earn more than the minimum", () => {
    // 2h50m at $40 = $113.33, more than $51
    const pay = weekPay(buildSessions(shift("2026-11-02", "17:00", "19:50")), 4000, NOVA_SCOTIA);
    expect(pay.callInTopUpCents).toBe(0);
  });

  it("flags more than 5 hours in a row without a 30-minute break", () => {
    const pay = weekPay(buildSessions(shift("2026-11-02", "16:00", "22:00")), 1800, NOVA_SCOTIA);
    expect(pay.warnings.some((w) => w.includes("without a 30-min break"))).toBe(true);
  });

  it("a 30-minute break clears the warning and is unpaid", () => {
    const punches = [
      p("in", "2026-11-02T16:00:00Z"),
      p("break_start", "2026-11-02T19:00:00Z"),
      p("break_end", "2026-11-02T19:30:00Z"),
      p("out", "2026-11-02T22:00:00Z"),
    ];
    const pay = weekPay(buildSessions(punches), 1800, NOVA_SCOTIA);
    expect(pay.paidMinutes).toBe(330);
    expect(pay.warnings).toEqual([]);
  });

  it("a 10-minute break does not count as the required break", () => {
    const punches = [
      p("in", "2026-11-02T16:00:00Z"),
      p("break_start", "2026-11-02T19:00:00Z"),
      p("break_end", "2026-11-02T19:10:00Z"),
      p("out", "2026-11-02T22:00:00Z"),
    ];
    const s = buildSessions(punches);
    expect(s[0].longestStretchMinutes).toBe(360);
    expect(weekPay(s, 1800, NOVA_SCOTIA).warnings.length).toBe(1);
  });

  it("warns when the hourly rate is under minimum wage", () => {
    const pay = weekPay([], 1650, NOVA_SCOTIA);
    expect(pay.warnings[0]).toContain("below the NS minimum wage");
  });
});

describe("turning punches into sessions", () => {
  it("handles shifts past midnight", () => {
    const s = buildSessions([p("in", "2026-11-06T22:00:00Z"), p("out", "2026-11-07T03:00:00Z")]);
    expect(s[0].paidMinutes).toBe(300);
  });

  it("sorts punches that arrive out of order (offline sync)", () => {
    const s = buildSessions([p("out", "2026-11-02T22:00:00Z"), p("in", "2026-11-02T18:00:00Z")]);
    expect(s).toHaveLength(1);
    expect(s[0].paidMinutes).toBe(240);
  });

  it("keeps and flags a forgotten clock-out instead of dropping it", () => {
    const s = buildSessions([p("in", "2026-11-02T18:00:00Z"), p("in", "2026-11-03T18:00:00Z"), p("out", "2026-11-03T22:00:00Z")]);
    expect(s).toHaveLength(2);
    expect(s[0].flags).toContain("Missing clock-out");
    expect(s[0].paidMinutes).toBe(0);
    expect(s[1].paidMinutes).toBe(240);
  });

  it("flags a clock-out with no clock-in", () => {
    const s = buildSessions([p("out", "2026-11-02T22:00:00Z")]);
    expect(s[0].flags[0]).toContain("no clock-in");
  });
});
