import { describe, expect, it } from "vitest";
import { splitTips } from "../src/lib/tips";

describe("tip pool split", () => {
  it("splits by hours worked", () => {
    const r = splitTips(30000, [
      { staffId: "a", minutes: 480 },
      { staffId: "b", minutes: 240 },
    ]);
    expect(r.map((x) => x.amountCents)).toEqual([20000, 10000]);
  });

  it("always adds up to the exact pool, to the cent", () => {
    const r = splitTips(10000, [
      { staffId: "a", minutes: 100 },
      { staffId: "b", minutes: 100 },
      { staffId: "c", minutes: 100 },
    ]);
    expect(r.reduce((t, x) => t + x.amountCents, 0)).toBe(10000);
    expect(r.map((x) => x.amountCents).sort()).toEqual([3333, 3333, 3334]);
  });

  it("gives nothing to people who did not work", () => {
    const r = splitTips(5000, [
      { staffId: "a", minutes: 0 },
      { staffId: "b", minutes: 60 },
    ]);
    expect(r).toEqual([
      { staffId: "a", minutes: 0, amountCents: 0 },
      { staffId: "b", minutes: 60, amountCents: 5000 },
    ]);
  });

  it("handles an empty night", () => {
    expect(splitTips(5000, [])).toEqual([]);
    expect(splitTips(0, [{ staffId: "a", minutes: 60 }])[0].amountCents).toBe(0);
  });
});
