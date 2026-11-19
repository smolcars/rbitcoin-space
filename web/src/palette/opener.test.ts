import { describe, expect, it } from "vitest";
import { active, IDLE, type Opener, type OpenerEvent, shown, step } from "./opener";

const EVENTS: OpenerEvent[] = ["press", "escape", "arrived", "failed", "navigation", "closed"];

/** Every sequence of events of length 1 to `n`. */
function sequences(n: number): OpenerEvent[][] {
  const all: OpenerEvent[][] = [];
  let level: OpenerEvent[][] = [[]];
  for (let i = 0; i < n; i += 1) {
    level = level.flatMap((s) => EVENTS.map((e) => [...s, e]));
    all.push(...level);
  }
  return all;
}

/** The states a sequence passes through from idle, after each event. */
const run = (events: readonly OpenerEvent[]): Opener[] => {
  const states: Opener[] = [];
  let s = IDLE;
  for (const e of events) {
    s = step(s, e);
    states.push(s);
  }
  return states;
};

const ALL = sequences(4);
const name = (events: readonly OpenerEvent[]) => events.join(" ");

describe("the palette's opener", () => {
  it("walks 1,554 sequences", () => {
    expect(ALL).toHaveLength(6 + 36 + 216 + 1296);
  });

  it("never opens after a navigation that came after the press", () => {
    const bad: string[] = [];
    for (const events of ALL) {
      const states = run(events);
      states.forEach((s, i) => {
        const before = i === 0 ? IDLE : states[i - 1];
        if (s.kind !== "open" || before?.kind === "open") return;
        const seen = events.slice(0, i + 1);
        if (seen.lastIndexOf("navigation") > seen.lastIndexOf("press")) bad.push(name(events));
      });
    }
    expect(bad).toStrictEqual([]);
  });

  it("toggles its intent with each press while the code loads: an odd count opens", () => {
    for (let presses = 1; presses <= 4; presses += 1) {
      const events: OpenerEvent[] = [
        ...Array.from({ length: presses }, (): OpenerEvent => "press"),
        "arrived",
      ];
      expect({ presses, state: run(events).at(-1)?.kind }).toStrictEqual({
        presses,
        state: presses % 2 === 1 ? "open" : "idle",
      });
    }
  });

  it("opens on arrival only if a press is the last word since loading began", () => {
    const bad: string[] = [];
    for (const events of ALL) {
      const states = run(events);
      events.forEach((e, i) => {
        const before = i === 0 ? IDLE : states[i - 1];
        if (e !== "arrived" || before?.kind !== "loading") return;
        // Replay the intent from the press that started the load.
        let start = i;
        while (start > 0 && states[start - 1]?.kind === "loading") start -= 1;
        let want = false;
        for (const x of events.slice(start, i)) {
          if (x === "press") want = !want;
          else if (x === "escape" || x === "navigation") want = false;
        }
        if ((states[i]?.kind === "open") !== want) bad.push(name(events));
      });
    }
    expect(bad).toStrictEqual([]);
  });

  it("runs a row only while open, never while loading or closing", () => {
    for (const events of ALL) {
      for (const s of run(events)) {
        expect({ state: s.kind, active: active(s) }).toStrictEqual({
          state: s.kind,
          active: s.kind === "open",
        });
        expect(shown(s)).toBe(s.kind === "open" || s.kind === "closing");
      }
    }
  });

  it("reopens once the close finishes when pressed while closing; Escape or a navigation withdraws it", () => {
    const bad: string[] = [];
    for (const events of ALL) {
      for (const s of run(events)) {
        if (s.kind !== "closing" || s.reopen) continue;
        if (step(step(s, "press"), "closed").kind !== "open")
          bad.push(`${name(events)} press closed`);
        for (const undo of ["escape", "navigation"] as const) {
          if (step(step(step(s, "press"), undo), "closed").kind !== "idle") {
            bad.push(`${name(events)} press ${undo} closed`);
          }
        }
        if (step(s, "closed").kind !== "idle") bad.push(`${name(events)} closed`);
      }
    }
    expect(bad).toStrictEqual([]);
  });

  it("goes back to idle when the code fails, and the next press tries again", () => {
    const bad: string[] = [];
    for (const events of ALL) {
      for (const s of run(events)) {
        if (s.kind !== "loading") continue;
        const failed = step(s, "failed");
        if (failed.kind !== "idle") bad.push(name(events));
        const again = step(failed, "press");
        if (again.kind !== "loading" || !again.want) bad.push(`${name(events)} press`);
      }
    }
    expect(bad).toStrictEqual([]);
  });

  it("closes from open on a press, Escape or a navigation, and nothing else", () => {
    const open: Opener = { kind: "open" };
    expect(EVENTS.map((e) => [e, step(open, e).kind])).toStrictEqual([
      ["press", "closing"],
      ["escape", "closing"],
      ["arrived", "open"],
      ["failed", "open"],
      ["navigation", "closing"],
      ["closed", "open"],
    ]);
  });
});
