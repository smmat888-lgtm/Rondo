import { beforeEach, describe, expect, it } from "vitest";
import * as auto from "../src/lib/automation";
import { buildDraft, demandFromHistory, type HistoryWeek } from "../src/lib/autoschedule";
import { checkSchedule, plannedBreak, type Context, type PlanShift, type PlanStaff } from "../src/lib/compliance";
import { DEMO_VENUE, openDb, seedDemo, type DB } from "../src/lib/db";
import { seedDemoActivity } from "../src/lib/demo";
import { flushEmail, listNotifications } from "../src/lib/notify";
import * as repo from "../src/lib/repo";
import { NOVA_SCOTIA } from "../src/lib/rules";
import { zonedToUtc } from "../src/lib/time";

const TZ = "America/Halifax";
// Week of Mon Nov 9, 2026 (Atlantic Standard Time, UTC-4)
const ctx = (over: Partial<Context> = {}): Context => ({
  rules: NOVA_SCOTIA,
  tz: TZ,
  weekFromUtc: zonedToUtc("2026-11-09", "00:00", TZ),
  weekToUtc: zonedToUtc("2026-11-16", "00:00", TZ),
  availability: [],
  timeOff: [],
  ...over,
});
const at = (date: string, time: string) => zonedToUtc(date, time, TZ);
const sh = (staffId: string, date: string, start: string, end: string, role = "Bartender", endDate = date): PlanShift => ({
  id: `${staffId}-${date}-${start}`,
  staffId,
  role,
  startAt: at(date, start),
  endAt: at(endDate, end),
});
const person = (id: string, role = "Bartender", rate = 1800, max: number | null = null): PlanStaff => ({ id, name: id, role, hourlyRateCents: rate, maxWeekMinutes: max });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("rule check before publishing", () => {
  it("warns about overtime and prices it", () => {
    // 5 shifts of 10.5h = 52.5h paid (10h each after the 30-min break) = 50h, 2h over
    const shifts = ["09", "10", "11", "12", "13"].map((d) => sh("maria", `2026-11-${d}`, "08:00", "18:30"));
    const issues = checkSchedule(shifts, [person("maria")], ctx());
    const ot = issues.find((i) => i.code === "overtime")!;
    expect(ot.level).toBe("warn");
    // 2h x $18 x 0.5 premium = $18
    expect(ot.extraCostCents).toBe(1800);
  });

  it("warns that a 2-hour shift costs the 3-hour minimum", () => {
    const issues = checkSchedule([sh("maria", "2026-11-10", "17:00", "19:00")], [person("maria", "Bartender", 1700)], ctx());
    const callIn = issues.find((i) => i.code === "call_in")!;
    expect(callIn.extraCostCents).toBe(1700);
  });

  it("blocks double booking and shifts on approved time off", () => {
    const shifts = [sh("maria", "2026-11-10", "17:00", "23:00"), sh("maria", "2026-11-10", "20:00", "02:00", "Bartender", "2026-11-11")];
    const issues = checkSchedule(shifts, [person("maria")], ctx({ timeOff: [{ staffId: "maria", date: "2026-11-10" }] }));
    expect(codes(issues.filter((i) => i.level === "block"))).toEqual(expect.arrayContaining(["overlap", "time_off"]));
  });

  it("blocks a pay rate below minimum wage", () => {
    const issues = checkSchedule([sh("maria", "2026-11-10", "17:00", "23:00")], [person("maria", "Bartender", 1600)], ctx());
    expect(issues[0].code).toBe("below_min_wage");
  });

  it("understands availability windows that run past midnight", () => {
    // Available Friday (dow 5) 17:00 to 03:00; a Saturday 01:00-03:00 shift is still inside Friday's window
    const c = ctx({ availability: [{ staffId: "maria", dow: 5, start: "17:00", end: "03:00" }] });
    const ok = checkSchedule([sh("maria", "2026-11-13", "18:00", "02:00", "Bartender", "2026-11-14")], [person("maria")], c);
    expect(codes(ok)).not.toContain("availability");
    const bad = checkSchedule([sh("maria", "2026-11-12", "18:00", "23:00")], [person("maria")], c);
    expect(codes(bad)).toContain("availability");
  });

  it("warns when someone gets no 24 hours off in the week", () => {
    const days = ["09", "10", "11", "12", "13", "14", "15"];
    const shifts = days.map((d) => sh("maria", `2026-11-${d}`, "12:00", "17:00"));
    expect(codes(checkSchedule(shifts, [person("maria")], ctx()))).toContain("weekly_rest");
    expect(codes(checkSchedule(shifts.slice(0, 6), [person("maria")], ctx()))).not.toContain("weekly_rest");
  });

  it("plans the break so nobody works more than 5 hours in a row", () => {
    const b = plannedBreak(at("2026-11-13", "17:00"), at("2026-11-14", "02:00"), NOVA_SCOTIA)!;
    // 9h shift: break at 21:15, leaving 4h15m before and 4h15m after
    expect(b.startAt).toBe(at("2026-11-13", "21:15"));
    expect(b.twoNeeded).toBe(false);
    expect(plannedBreak(at("2026-11-13", "17:00"), at("2026-11-13", "21:00"), NOVA_SCOTIA)).toBeNull();
    expect(plannedBreak(at("2026-11-13", "08:00"), at("2026-11-13", "20:00"), NOVA_SCOTIA)!.twoNeeded).toBe(true);
  });
});

describe("auto-build a draft week", () => {
  // Four past weeks: Maria bartends Friday 17-02 every week; a Tuesday shift happened once.
  const history: HistoryWeek[] = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"].map((weekStart, i) => {
    const fri = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 4 * 86400000).toISOString().slice(0, 10);
    const sat = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 5 * 86400000).toISOString().slice(0, 10);
    const tue = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 1 * 86400000).toISOString().slice(0, 10);
    const shifts = [sh("maria", fri, "17:00", "02:00", "Bartender", sat), sh("jamal", fri, "17:00", "23:00", "Server"), sh("sophie", fri, "17:00", "23:00", "Server")];
    if (i === 0) shifts.push(sh("jamal", tue, "17:00", "22:00", "Server"));
    return { weekStart, shifts };
  });
  const staff = [person("maria"), person("noah", "Bartender", 1750, 24 * 60), person("jamal", "Server", 1700), person("sophie", "Server", 1700)];

  it("copies the usual week and leaves out one-off shifts", () => {
    const slots = demandFromHistory(history, "2026-11-09", TZ);
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.startAt === at("2026-11-13", "17:00"))).toBe(true);
    expect(slots.find((s) => s.role === "Bartender")!.endAt).toBe(at("2026-11-14", "02:00"));
  });

  it("gives each shift to the person who usually works it", () => {
    const d = buildDraft({ history, weekStart: "2026-11-09", staff, ctx: ctx() });
    expect(d.assigned.map((a) => [a.staffId, a.role]).sort()).toEqual([
      ["jamal", "Server"],
      ["maria", "Bartender"],
      ["sophie", "Server"],
    ]);
    expect(d.open).toHaveLength(0);
    // Maria 8.5h x $18 + Jamal and Sophie 5.5h x $17 each
    expect(d.costCents).toBe(15300 + 9350 + 9350);
  });

  it("moves a shift to someone else when the usual person has time off", () => {
    const d = buildDraft({ history, weekStart: "2026-11-09", staff, ctx: ctx({ timeOff: [{ staffId: "maria", date: "2026-11-13" }] }) });
    expect(d.assigned.find((a) => a.role === "Bartender")!.staffId).toBe("noah");
  });

  it("posts the shift as open when nobody can take it", () => {
    const c = ctx({ timeOff: [{ staffId: "maria", date: "2026-11-13" }, { staffId: "noah", date: "2026-11-13" }] });
    const d = buildDraft({ history, weekStart: "2026-11-09", staff, ctx: c });
    expect(d.open.map((o) => o.role)).toEqual(["Bartender"]);
    expect(d.notes.join(" ")).toContain("posted as open");
  });

  it("drops the least regular shift to meet the labour budget, never the last person in a role", () => {
    const d = buildDraft({ history, weekStart: "2026-11-09", staff, ctx: ctx(), budgetCents: 30000 });
    expect(d.trimmed).toHaveLength(1);
    expect(d.trimmed[0].role).toBe("Server");
    expect(d.assigned.filter((a) => a.role === "Server")).toHaveLength(1);
    expect(d.costCents).toBeLessThanOrEqual(30000);
    const tight = buildDraft({ history, weekStart: "2026-11-09", staff, ctx: ctx(), budgetCents: 100 });
    expect(tight.assigned.map((a) => a.role).sort()).toEqual(["Bartender", "Server"]);
    expect(tight.notes.join(" ")).toContain("Couldn't get under the budget");
  });

  it("never schedules anyone into overtime automatically", () => {
    // One bartender with 44h already this week can't take a 9h Friday close
    const busy = ["09", "10", "11", "12"].map((d) => sh("maria", `2026-11-${d}`, "08:00", "19:30"));
    const d = buildDraft({ history: [{ weekStart: "2026-11-02", shifts: [...busy.map((b) => ({ ...b, startAt: new Date(Date.parse(b.startAt) - 7 * 86400000).toISOString(), endAt: new Date(Date.parse(b.endAt) - 7 * 86400000).toISOString() })), sh("maria", "2026-11-06", "17:00", "02:00", "Bartender", "2026-11-07")] }], weekStart: "2026-11-09", staff: [person("maria")], ctx: ctx() });
    expect(d.assigned).toHaveLength(4);
    expect(d.open).toHaveLength(1);
  });
});

describe("open shifts fill themselves", () => {
  let db: DB;
  let venue: repo.Venue;
  // Wednesday Nov 4, 2026, noon in Halifax
  const now = new Date("2026-11-04T16:00:00Z");

  beforeEach(() => {
    db = openDb(":memory:");
    seedDemo(db);
    seedDemoActivity(db, now);
    venue = repo.getVenue(db, DEMO_VENUE);
  });

  it("builds next week from the last four, routes around Maria's day off, and publishes", () => {
    const built = auto.autoBuildWeek(db, venue, "2026-11-09", {}, now);
    expect(built.created).toBeGreaterThan(15);
    const range = repo.weekRange(venue, "2026-11-09");
    const shifts = repo.listShifts(db, DEMO_VENUE, range.fromUtc, range.toUtc);
    const friBar = shifts.find((s) => s.role === "Bartender" && s.startAt === at("2026-11-13", "17:00"))!;
    expect(friBar.staffId).toBe("staff-noah");

    // Staff can't see a draft
    expect(repo.myWeek(db, venue, "staff-noah", "2026-11-09").shifts).toHaveLength(0);
    expect(() => auto.autoBuildWeek(db, venue, "2026-11-09", {}, now)).toThrow(/Rebuild/);

    const result = auto.publishWeek(db, venue, "2026-11-09", { confirmWarnings: true }, now);
    expect(result.published).toBe(true);
    expect(result.breaksAdded).toBeGreaterThan(0);
    const mine = repo.myWeek(db, venue, "staff-noah", "2026-11-09").shifts;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.find((s) => s.startAt === friBar.startAt)!.note).toMatch(/^30-min break around/);
    expect(listNotifications(db, DEMO_VENUE, "staff-noah")[0].subject).toContain("schedule");
    expect(() => auto.autoBuildWeek(db, venue, "2026-11-09", { replace: true }, now)).toThrow(/already published/);
  });

  it("will not publish a week that breaks a hard rule", () => {
    repo.createShift(db, venue, { staffId: "staff-maria", date: "2026-11-13", start: "17:00", end: "23:00" });
    const r = auto.publishWeek(db, venue, "2026-11-09", { confirmWarnings: true }, now);
    expect(r.published).toBe(false);
    expect(r.issues[0].code).toBe("time_off");
  });

  it("turns a call-out into an open shift and starts asking right away", () => {
    // Jamal can't make Friday's server shift (this week, 2 days out)
    const range = repo.weekRange(venue, "2026-11-06");
    const jamalFri = repo.listShifts(db, DEMO_VENUE, range.fromUtc, range.toUtc).find((s) => s.staffId === "staff-jamal" && s.startAt === at("2026-11-06", "17:00"))!;
    const open = auto.callOut(db, venue, jamalFri.id, "staff", now);
    expect(open.status).toBe("open");
    // Sophie is already on Friday night, so Priya is the one eligible server
    expect(open.offers.map((o) => o.staffId)).toEqual(["staff-priya"]);
    expect(listNotifications(db, DEMO_VENUE, null)[0].subject).toContain("can't make");
    expect(listNotifications(db, DEMO_VENUE, "staff-jamal")[0].body).toContain("don't need to find a replacement");
    expect(repo.getShift(db, DEMO_VENUE, jamalFri.id)).toBeNull();
  });

  it("asks one person at a time when the shift is days away, and the next one after a no", () => {
    const o = auto.postOpenShift(db, venue, { date: "2026-11-07", start: "11:00", end: "17:00", role: "Server" }, now);
    expect(o.offers).toHaveLength(1);
    const first = o.offers[0].staffId;
    const offer = auto.offersFor(db, venue, first, now)[0];
    expect(auto.answerOffer(db, venue, offer.offerId, first, false, now)).toEqual({ ok: true });
    const after = auto.listOpenShifts(db, venue, "2026-11-07").find((x) => x.id === o.id)!;
    expect(after.offers).toHaveLength(2);
    const second = after.offers[1].staffId;
    expect(second).not.toBe(first);

    const yes = auto.answerOffer(db, venue, auto.offersFor(db, venue, second, now)[0].offerId, second, true, now);
    expect(yes.ok).toBe(true);
    expect(auto.listOpenShifts(db, venue, "2026-11-07").find((x) => x.id === o.id)!.status).toBe("filled");
    const range = repo.weekRange(venue, "2026-11-07");
    const added = repo.listShifts(db, DEMO_VENUE, range.fromUtc, range.toUtc).find((s) => s.staffId === second && s.startAt === at("2026-11-07", "11:00"))!;
    expect(added.note).toBe("30-min break around 1:45 p.m.");
    expect(listNotifications(db, DEMO_VENUE, null)[0].subject).toContain("picked up");
  });

  it("moves to the next person when an offer runs out of time", () => {
    const o = auto.postOpenShift(db, venue, { date: "2026-11-07", start: "11:00", end: "17:00", role: "Server" }, now);
    expect(o.offers).toHaveLength(1);
    auto.tickOpenShifts(db, venue, new Date(now.getTime() + 61 * 60000));
    const later = auto.listOpenShifts(db, venue, "2026-11-07").find((x) => x.id === o.id)!;
    expect(later.offers.map((x) => x.status)).toEqual(["expired", "pending"]);
  });

  it("asks everyone at once on the same day, and the first yes wins", () => {
    // 2 hours before a Wednesday 18:00 shift
    const soon = new Date(Date.parse(at("2026-11-04", "16:00")));
    const o = auto.postOpenShift(db, venue, { date: "2026-11-04", start: "18:00", end: "23:00", role: "Server" }, soon);
    const asked = o.offers.map((x) => x.staffId);
    expect(asked.length).toBeGreaterThan(1);
    const [a, b] = asked;
    const ra = auto.answerOffer(db, venue, auto.offersFor(db, venue, a, soon)[0].offerId, a, true, soon);
    expect(ra.ok).toBe(true);
    const offerB = db.prepare("SELECT id FROM shift_offers WHERE staff_id = ? AND open_shift_id = ?").get(b, o.id) as { id: string };
    expect(auto.answerOffer(db, venue, offerB.id, b, true, soon)).toEqual({ ok: false, reason: "Someone else already took this shift" });
    expect(listNotifications(db, DEMO_VENUE, b)[0].subject).toMatch(/^Taken/);
  });

  it("tells the manager when nobody can take it", () => {
    // Only Liam is a line cook
    const o = auto.postOpenShift(db, venue, { date: "2026-11-06", start: "10:00", end: "14:00", role: "Line cook" }, now);
    const liamBusy = o.offers.length === 0;
    if (!liamBusy) {
      auto.answerOffer(db, venue, auto.offersFor(db, venue, "staff-liam", now)[0].offerId, "staff-liam", false, now);
    }
    expect(auto.listOpenShifts(db, venue, "2026-11-06").find((x) => x.id === o.id)!.status).toBe("unfilled");
    expect(listNotifications(db, DEMO_VENUE, null)[0].subject).toContain("No one available");
  });

  it("emails a copy only when an email provider is set up", async () => {
    auto.postOpenShift(db, venue, { date: "2026-11-07", start: "11:00", end: "17:00", role: "Server" }, now);
    await flushEmail(db, null);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE email_status = 'queued'").get()).toEqual({ n: 0 });

    const sent: string[][] = [];
    auto.postOpenShift(db, venue, { date: "2026-11-08", start: "11:00", end: "17:00", role: "Server" }, now);
    await flushEmail(db, async (to) => {
      sent.push(to);
    });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0][0]).toMatch(/@example\.com$/);
  });
});
