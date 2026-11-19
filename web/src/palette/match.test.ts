import { describe, expect, it } from "vitest";
import { cleanAlias } from "../pages/lightning/lightning";
import { routes } from "../routes";
import {
  actions,
  GENESIS_TIME,
  orderGroups,
  type Offer,
  pages,
  rank,
  ranked,
  readDate,
  readPools,
  score,
} from "./match";
import { isPaletteKey } from "./PaletteKey";

const ALL: Offer = {
  network: "mainnet",
  networks: ["mainnet", "signet", "testnet4"],
  lightning: true,
  ark: true,
  broadcast: true,
};
const BARE: Offer = {
  network: "regtest",
  networks: ["regtest"],
  lightning: false,
  ark: false,
  broadcast: false,
};
const NOW = Date.UTC(2026, 10, 19, 12) / 1000;

describe("score", () => {
  it("puts an exact name over its start, a word's start, a keyword and letters in order", () => {
    const ladder = [
      score("mining", "Mining"),
      score("min", "Mining"),
      score("pen", "Lightning penalties"),
      score("rbf", "Replacements", ["rbf"]),
      score("ash", "Hashrate"),
      score("lnpen", "Lightning penalties"),
    ];
    expect(ladder.every((s) => s > 0)).toBe(true);
    // Each rung strictly below the one before.
    expect(ladder.filter((s, i) => i > 0 && s >= (ladder[i - 1] ?? 0))).toStrictEqual([]);
  });

  it("folds case, accents and punctuation", () => {
    expect(score("foundry usa", "Foundry-USA")).toBe(100);
    expect(score("SECPOOL", "SECPOOL")).toBe(100);
    expect(score("ckpool", "ČKPool")).toBe(100);
  });

  it("finds nothing in unrelated text, and needs three letters to match inside a word", () => {
    expect(score("xyz", "Mining")).toBe(0);
    expect(score("mg", "Mining")).toBe(0);
    expect(score("ac", "Replacements")).toBe(0);
    expect(score("ace", "Replacements")).toBeGreaterThan(0);
    expect(score("ac", "AntPool", ["acme"])).toBeGreaterThan(0);
  });

  it("matches everything when nothing is typed", () => {
    expect(score("", "Anything")).toBeGreaterThan(0);
  });
});

describe("rank", () => {
  it("finds Mining from its first letters, above pages that only mention it", () => {
    expect(rank("min", pages(ALL), (p) => p).map((p) => p.name)[0]).toBe("Mining");
  });

  it("keeps the given order among equals and drops what does not match", () => {
    const names = rank("lightning", pages(ALL), (p) => p).map((p) => p.name);
    expect(names).toStrictEqual(["Lightning", "Lightning rankings", "Lightning penalties"]);
  });

  it("finds a page by what it is for", () => {
    expect(rank("invoice", pages(ALL), (p) => p).map((p) => p.name)).toStrictEqual(["Decoder"]);
    expect(rank("rbf", pages(ALL), (p) => p).map((p) => p.name)[0]).toBe("Replacements");
  });
});

describe("group order", () => {
  it("puts the group with the better match first, the given order breaking ties", () => {
    const best = (q: string, names: string[]) =>
      ranked(q, names, (name) => ({ name }))[0]?.score ?? 0;
    const groups = [
      { name: "Pages", best: best("ant", ["Replacements", "Mining"]) },
      { name: "Mining pools", best: best("ant", ["AntPool", "Bitcoin Affiliate Network"]) },
      { name: "Actions", best: 0 },
    ];
    expect(orderGroups(groups).map((g) => g.name)).toStrictEqual([
      "Mining pools",
      "Pages",
      "Actions",
    ]);
    const tie = [
      { name: "a", best: 5 },
      { name: "b", best: 5 },
    ];
    expect(orderGroups(tie).map((g) => g.name)).toStrictEqual(["a", "b"]);
  });
});

describe("pages", () => {
  /** Every path pattern in a route list, children's included (relative to their parent's). */
  const patterns = (defs: unknown): string[] => {
    const out: string[] = [];
    for (const d of Array.isArray(defs) ? (defs as unknown[]) : [defs]) {
      if (typeof d !== "object" || d === null) continue;
      const path: unknown = "path" in d ? d.path : undefined;
      for (const p of Array.isArray(path) ? (path as unknown[]) : [path]) {
        if (typeof p === "string") out.push(p);
      }
      if ("children" in d) out.push(...patterns(d.children));
    }
    return out;
  };
  /** Whether a network-free path is one the route table serves, other than "not found". */
  const routed = (path: string): boolean => {
    const bare = path.split(/[?#]/)[0] ?? "";
    return patterns(routes).some(
      (p) => !p.startsWith("*") && new RegExp(`^${p.replaceAll(/:\w+/g, "[^/]+")}$`).test(bare),
    );
  };

  it("lists only real routes", () => {
    for (const p of pages(ALL))
      expect({ path: p.path, routed: routed(p.path) }).toStrictEqual({
        path: p.path,
        routed: true,
      });
  });

  it("leaves out what the server has switched off", () => {
    const names = pages(BARE).map((p) => p.name);
    expect(names).not.toContain("Lightning");
    expect(names).not.toContain("Lightning rankings");
    expect(names).not.toContain("Ark");
    expect(names).not.toContain("Broadcast");
    expect(names).toContain("Decoder");
    expect(pages(ALL).map((p) => p.name)).toContain("Broadcast");
  });
});

describe("actions", () => {
  it("offers the other networks the server has on, and the other theme", () => {
    expect(actions(ALL, "light").map((a) => a.name)).toStrictEqual([
      "Switch to Signet",
      "Switch to Testnet4",
      "Switch to dark theme",
    ]);
    expect(actions(BARE, "dark").map((a) => a.name)).toStrictEqual(["Switch to light theme"]);
  });
});

describe("readPools", () => {
  it("keeps good entries, cleans names and drops the rest", () => {
    const body = [
      { name: "Unknown", slug: "unknown", unique_id: 0 },
      { name: "Foundry\u{202E}USA", slug: "foundryusa" },
      { name: "<img src=x>", slug: "../../evil" },
      { name: 5, slug: "five" },
      "junk",
      null,
    ];
    expect(readPools(body, cleanAlias)).toStrictEqual([
      { name: "Unknown", slug: "unknown" },
      { name: "Foundry\u{FFFD}USA", slug: "foundryusa" },
    ]);
    expect(readPools({ pools: [] }, cleanAlias)).toStrictEqual([]);
  });
});

describe("readDate", () => {
  const at = (y: number, m: number, d: number, h: number, mi: number, s: number) =>
    Date.UTC(y, m - 1, d, h, mi, s) / 1000;

  it("reads a day as its end in UTC, so it finds that day's last block", () => {
    expect(readDate("2024-04-20", NOW)).toStrictEqual({
      at: at(2024, 4, 20, 23, 59, 59),
      label: "20 Apr 2024",
      timed: false,
      early: false,
      open: false,
    });
  });

  it("takes the same day in every unambiguous form", () => {
    const want = at(2024, 4, 20, 23, 59, 59);
    for (const form of [
      "2024/04/20",
      "2024.4.20",
      " 2024-04-20 ",
      "20 Apr 2024",
      "20 april 2024",
      "April 20, 2024",
      "Apr. 20th 2024",
      "2024-04-20 UTC",
    ]) {
      expect({ form, at: readDate(form, NOW)?.at }).toStrictEqual({ form, at: want });
    }
  });

  it("reads a time to the end of its minute, or its second", () => {
    expect(readDate("2024-04-20 14:30", NOW)).toStrictEqual({
      at: at(2024, 4, 20, 14, 30, 59),
      label: "20 Apr 2024, 14:30",
      timed: true,
      early: false,
      open: false,
    });
    expect(readDate("2024-04-20T00:09:27Z", NOW)?.at).toBe(at(2024, 4, 20, 0, 9, 27));
    expect(readDate("20 Apr 2024, 9:05", NOW)?.at).toBe(at(2024, 4, 20, 9, 5, 59));
  });

  it("refuses impossible days and times, ambiguous forms and other text", () => {
    for (const bad of [
      "2023-02-29",
      "2024-13-01",
      "2024-04-31",
      "2024-04-20 24:00",
      "2024-04-20 12:60",
      "04/20/2024",
      "20/04/2024",
      "2024-04",
      "840000",
      "Foundry USA",
      "20 Foo 2024",
      "2024-04/20",
    ]) {
      expect({ bad, read: readDate(bad, NOW) }).toStrictEqual({ bad, read: null });
    }
    expect(readDate("2024-02-29", NOW)).not.toBeNull();
  });

  it("marks a cutoff still to come as open, and a passed one by its own second", () => {
    const before = Date.UTC(2026, 10, 19, 23, 58, 55) / 1000;
    const after = Date.UTC(2026, 10, 20, 0, 0, 5) / 1000;
    expect(readDate("2026-11-19", before)).toMatchObject({ at: before, open: true });
    expect(readDate("2026-11-19", after)).toMatchObject({
      at: Date.UTC(2026, 10, 19, 23, 59, 59) / 1000,
      open: false,
    });
    expect(readDate("2024-04-20", after)?.open).toBe(false);
  });

  it("sends whole seconds for today, where it stops at a fractional now", () => {
    const now = NOW + 0.992;
    const today = readDate("2026-11-19", now);
    expect(today?.at).toBe(NOW);
    expect(Number.isInteger(today?.at)).toBe(true);
  });

  it("marks a time before the first block as early, and stops at now", () => {
    expect(readDate("2009-01-02", NOW)).toStrictEqual({
      at: Date.UTC(2009, 0, 2, 23, 59, 59) / 1000,
      label: "2 Jan 2009",
      timed: false,
      early: true,
      open: false,
    });
    expect(readDate("2009-01-03 18:15:04", NOW)?.early).toBe(true);
    expect(readDate("2009-01-03", NOW)?.early).toBe(false);
    expect(readDate("2009-01-03", NOW)?.at).toBeGreaterThan(GENESIS_TIME);
    expect(readDate("2026-12-25", NOW)?.at).toBe(NOW);
    expect(readDate("2099-01-01", NOW)).toBeNull();
  });
});

describe("isPaletteKey", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("is ⌘K on Apple's keyboards and Ctrl K on others", () => {
    expect(isPaletteKey(key({ key: "k", metaKey: true }), true)).toBe(true);
    expect(isPaletteKey(key({ key: "k", ctrlKey: true }), true)).toBe(false);
    expect(isPaletteKey(key({ key: "k", ctrlKey: true }), false)).toBe(true);
    expect(isPaletteKey(key({ key: "K", ctrlKey: true }), false)).toBe(true);
    expect(isPaletteKey(key({ key: "k", metaKey: true }), false)).toBe(false);
  });

  it("leaves other keys and other modifiers alone", () => {
    expect(isPaletteKey(key({ key: "k" }), false)).toBe(false);
    expect(isPaletteKey(key({ key: "j", ctrlKey: true }), false)).toBe(false);
    expect(isPaletteKey(key({ key: "k", ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPaletteKey(key({ key: "k", ctrlKey: true, altKey: true }), false)).toBe(false);
    // A key an input method is composing with is the input method's.
    expect(isPaletteKey(key({ key: "k", metaKey: true, isComposing: true }), true)).toBe(false);
    expect(isPaletteKey(key({ key: "Process", code: "KeyK", metaKey: true }), true)).toBe(false);
    // Another layout's letter on the K key.
    expect(isPaletteKey(key({ key: "л", code: "KeyK", ctrlKey: true }), false)).toBe(true);
  });
});
