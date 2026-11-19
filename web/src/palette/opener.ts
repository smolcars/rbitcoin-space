// Whether the command palette is shown, as one small state machine. Pure: PaletteKey.tsx feeds
// it events and draws its state, and opener.test.ts walks it through every short sequence.

/**
 * - `idle`: nothing shown.
 * - `loading`: the palette's code is downloading; `want` is whether it should open on arrival.
 * - `open`: shown, and the only state in which a row may be run.
 * - `closing`: fading out; `reopen` is whether to open again once the fade ends.
 */
export type Opener =
  | { kind: "idle" }
  | { kind: "loading"; want: boolean }
  | { kind: "open" }
  | { kind: "closing"; reopen: boolean };

/**
 * - `press`: the shortcut, the hint or the phone's "Go to": toggles.
 * - `escape`: Escape, a press outside, or an action that is done: the reader is finished with it.
 * - `arrived` and `failed`: the code's download.
 * - `navigation`: the page is changing, Back included.
 * - `closed`: the fade has ended and the dialog is closed.
 */
export type OpenerEvent = "press" | "escape" | "arrived" | "failed" | "navigation" | "closed";

export const IDLE: Opener = { kind: "idle" };

export function step(state: Opener, event: OpenerEvent): Opener {
  switch (state.kind) {
    case "idle": {
      return event === "press" ? { kind: "loading", want: true } : state;
    }
    case "loading": {
      if (event === "press") return { kind: "loading", want: !state.want };
      if (event === "escape" || event === "navigation") return { kind: "loading", want: false };
      if (event === "arrived") return state.want ? { kind: "open" } : IDLE;
      // The next press asks for the code again.
      if (event === "failed") return IDLE;
      return state;
    }
    case "open": {
      if (event === "press" || event === "escape" || event === "navigation") {
        return { kind: "closing", reopen: false };
      }
      return state;
    }
    case "closing": {
      if (event === "press") return { kind: "closing", reopen: !state.reopen };
      if (event === "escape" || event === "navigation") return { kind: "closing", reopen: false };
      // The code is in: it was open a moment ago.
      if (event === "closed") return state.reopen ? { kind: "open" } : IDLE;
      return state;
    }
    default: {
      return state;
    }
  }
}

/** Whether the palette is drawn: open, or fading out. */
export const shown = (state: Opener): boolean => state.kind === "open" || state.kind === "closing";

/** Whether a row may be run: only while open, never during the fade. */
export const active = (state: Opener): boolean => state.kind === "open";
