import { describe, expect, it } from "vitest";
import {
  change,
  type DifficultyAdjustment,
  isDifficultyAdjustment,
  paceText,
  periodText,
  retargets,
  retargetUtc,
  until,
} from "./difficulty";

const reply: DifficultyAdjustment = {
  progressPercent: 89.0377,
  difficultyChange: -7.046,
  estimatedRetargetDate: 1_794_603_243_583,
  remainingBlocks: 221,
  previousRetarget: 5.539,
  nextRetargetHeight: 975_744,
  expectedBlocks: 1932.47,
};

describe("difficulty wording", () => {
  it("names the direction in words with an arrow", () => {
    expect(change(2.3149)).toStrictEqual({ direction: "up", text: "Up 2.31%", arrow: "↑" });
    expect(change(-7.046)).toStrictEqual({ direction: "down", text: "Down 7.05%", arrow: "↓" });
    expect(change(0)).toStrictEqual({ direction: "none", text: "No change", arrow: "→" });
    expect(change(0.004).text).toBe("No change");
    expect(change(Number.NaN).text).toBe("No change");
  });

  it("says regtest never retargets, and the others do", () => {
    expect(retargets("regtest")).toBe(false);
    expect(retargets("mainnet")).toBe(true);
    expect(retargets("signet")).toBe(true);
    expect(retargets("testnet4")).toBe(true);
    expect(retargets("testnet5")).toBe(true);
  });

  it("counts the period and compares it with the target pace", () => {
    expect(periodText(reply)).toBe("1 795 of 2 016 blocks");
    expect(paceText(reply)).toBe(
      "137 blocks behind one every 10 minutes, so blocks are coming slower than the target.",
    );
    expect(paceText({ ...reply, expectedBlocks: 1794 })).toBe(
      "1 block ahead of one every 10 minutes, so blocks are coming faster than the target.",
    );
    expect(paceText({ ...reply, expectedBlocks: 1795.2 })).toContain("at the target pace");
  });

  it("says when the next adjustment is due", () => {
    const now = 1_794_000_000_000;
    expect(until(now + 30_000, now)).toBe("any moment");
    expect(until(now + 12 * 60_000, now)).toBe("in 12 min");
    expect(until(now + (5 * 60 + 20) * 60_000, now)).toBe("in 5 h 20 min");
    expect(until(now + 3 * 3_600_000, now)).toBe("in 3 h");
    expect(until(now + 4 * 86_400_000, now)).toBe("in 4 days");
    expect(until(now - 60_000, now)).toBe("any moment");
    expect(retargetUtc(reply.estimatedRetargetDate)).toBe("13 Nov 2026, 20:54 UTC");
  });

  it("checks the reply's shape", () => {
    expect(isDifficultyAdjustment(reply)).toBe(true);
    expect(isDifficultyAdjustment({ ...reply, remainingBlocks: "221" })).toBe(false);
    expect(isDifficultyAdjustment(null)).toBe(false);
  });
});
