// What every page promises whatever the reader's font: no text runs into other text, no text is
// cut where it cannot be read whole, and controls keep their labels on one line.
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

/**
 * Faults in the page as drawn now, in words: text over other text, text cut by a box that does not
 * scroll (unless its whole is in a title, as a long name's or a hash's is), a control's label on
 * two lines, and the page wider than the window.
 */
export function layoutFaults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    interface Box {
      l: number;
      t: number;
      r: number;
      b: number;
    }
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.classList.length > 0 ? `.${[...el.classList].join(".")}` : ""}`;
    const said = (s: string) => {
      const t = s.replaceAll(/\s+/g, " ").trim();
      return t.length > 40 ? `${t.slice(0, 39)}…` : t;
    };

    // What of an element's content is in sight (`box`), and the bounds past which scrolling can
    // never bring it into sight (`hard`). A box that hides overflow narrows `hard` to itself; a
    // box that scrolls sets it, on that axis, to the part of its window still reachable, widened
    // by how far it can scroll each way.
    interface Clip {
      box: Box;
      hard: Box;
    }
    const OPEN: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    const clips = new Map<Element, Clip>();
    const clipOf = (el: Element | null): Clip => {
      if (!el || el === document.documentElement) return { box: OPEN, hard: OPEN };
      const known = clips.get(el);
      if (known !== undefined) return known;
      const up = clipOf(el.parentElement);
      const s = getComputedStyle(el);
      // Each axis on its own: `overflow-y: clip` keeps `overflow-x: visible`.
      const cx = s.overflowX !== "visible";
      const cy = s.overflowY !== "visible";
      let clip = up;
      if (cx || cy) {
        const r = el.getBoundingClientRect();
        const l = r.left + el.clientLeft;
        const t = r.top + el.clientTop;
        const own = { l, t, r: l + el.clientWidth, b: t + el.clientHeight };
        const x = /auto|scroll/.test(s.overflowX);
        const y = /auto|scroll/.test(s.overflowY);
        clip = {
          box: {
            l: cx ? Math.max(own.l, up.box.l) : up.box.l,
            t: cy ? Math.max(own.t, up.box.t) : up.box.t,
            r: cx ? Math.min(own.r, up.box.r) : up.box.r,
            b: cy ? Math.min(own.b, up.box.b) : up.box.b,
          },
          hard: {
            l: cx ? Math.max(own.l, up.hard.l) - (x ? el.scrollLeft : 0) : up.hard.l,
            r: cx
              ? Math.min(own.r, up.hard.r) +
                (x ? el.scrollWidth - el.clientWidth - el.scrollLeft : 0)
              : up.hard.r,
            t: cy ? Math.max(own.t, up.hard.t) - (y ? el.scrollTop : 0) : up.hard.t,
            b: cy
              ? Math.min(own.b, up.hard.b) +
                (y ? el.scrollHeight - el.clientHeight - el.scrollTop : 0)
              : up.hard.b,
          },
        };
      }
      clips.set(el, clip);
      return clip;
    };

    // Shown at all: not hidden, faded out, in a closed disclosure or only for screen readers.
    const shown = new Map<Element, boolean>();
    const isShown = (el: Element): boolean => {
      const known = shown.get(el);
      if (known !== undefined) return known;
      const yes =
        el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        el.closest(".visually-hidden") === null;
      shown.set(el, yes);
      return yes;
    };

    // A cut name or hash carries its whole in a title, as the design asks; a shortened one
    // ("a3f9c2e1…7b0d44e9") its two ends.
    const inTitle = (el: Element, text: string) => {
      const whole = (el.closest("[title]")?.getAttribute("title") ?? "").replaceAll(/\s/g, "");
      return text
        .replaceAll(/\s/g, "")
        .split("…")
        .every((part) => whole.includes(part));
    };

    // Whether what follows a text's "…" (a short form's end) reaches past `hard`.
    const endCut = (node: Text, hard: Box) => {
      const text = node.textContent ?? "";
      const at = text.lastIndexOf("…");
      if (at === -1 || at === text.length - 1) return false;
      const end = document.createRange();
      end.setStart(node, at + 1);
      end.setEnd(node, text.length);
      return [...end.getClientRects()].some(
        (r) =>
          r.left < hard.l - 1 ||
          r.right > hard.r + 1 ||
          r.top < hard.t - 1 ||
          r.bottom > hard.b + 1,
      );
    };

    // Every line of text on the page as drawn: what of it is in sight, and whether it was cut.
    const lines: { el: Element; node: Text; box: Box }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const node = n as Text;
      const el = node.parentElement;
      if (!el || (node.textContent ?? "").trim() === "") continue;
      if (el.closest("script, style, noscript, title") || !isShown(el)) continue;
      range.selectNodeContents(node);
      const clip = clipOf(el);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
        const seen = {
          l: Math.max(box.l, clip.box.l),
          t: Math.max(box.t, clip.box.t),
          r: Math.min(box.r, clip.box.r),
          b: Math.min(box.b, clip.box.b),
        };
        // Wholly out of sight: scrolled away, or kept only for screen readers by design.
        if (seen.r - seen.l < 2 || seen.b - seen.t < 2) continue;
        // Cut, on any edge, where no scrolling can show it.
        const { hard } = clip;
        const cut =
          box.l < hard.l - 1 || box.r > hard.r + 1 || box.t < hard.t - 1 || box.b > hard.b + 1;
        if (cut && !inTitle(el, node.textContent ?? "")) {
          out.push(`"${said(node.textContent ?? "")}" is cut (${name(el)})`);
        } else if (cut && endCut(node, hard)) {
          // Its whole is in a title, but a short form ("mwLW3XD…UAuat") is already as short as it
          // gets: it fits whole, or gives way before its "…", never losing its last characters.
          out.push(`"${said(node.textContent ?? "")}" loses its end (${name(el)})`);
        }
        lines.push({ el, node, box: seen });
      }
    }

    // A hash's tail (Hash's `.hash--ends` and `.hash--fit`, after a head that gives way) is never
    // cut, even wholly out of sight past the box that cuts the head.
    for (const tail of document.querySelectorAll(
      ".hash--ends .hash__tail, .hash--fit .hash__tail",
    )) {
      if (!isShown(tail)) continue;
      const { hard } = clipOf(tail);
      range.selectNodeContents(tail);
      const lost = [...range.getClientRects()].some(
        (r) =>
          r.left < hard.l - 1 ||
          r.right > hard.r + 1 ||
          r.top < hard.t - 1 ||
          r.bottom > hard.b + 1,
      );
      if (lost) {
        const whole = tail.parentElement?.textContent ?? "";
        out.push(`"${said(whole)}" loses its end (${name(tail)})`);
      }
    }

    // Text over other text: lines of two different texts that share more than a sliver.
    lines.sort((a, b) => a.box.t - b.box.t);
    const reported = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i];
      if (!a) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        if (!b || b.box.t >= a.box.b) break;
        if (a.node === b.node) continue;
        const across = Math.min(a.box.r, b.box.r) - Math.max(a.box.l, b.box.l);
        const down = Math.min(a.box.b, b.box.b) - Math.max(a.box.t, b.box.t);
        const shorter = Math.min(a.box.b - a.box.t, b.box.b - b.box.t);
        if (across > 1 && down > shorter * 0.4) {
          const fault = `"${said(a.node.textContent ?? "")}" (${name(a.el)}) runs into "${said(b.node.textContent ?? "")}" (${name(b.el)})`;
          if (!reported.has(fault)) out.push(fault);
          reported.add(fault);
        }
      }
    }

    // A control's label on one line, unless the control already takes its whole row: a button, a
    // tab or a section link squeezed narrower than its words.
    const CONTROL = "button, [role='tab'], .btn, nav a, summary";
    const rows = new Map<Element, number[]>();
    for (const line of lines) {
      const control = line.el.closest(CONTROL);
      if (control) rows.set(control, [...(rows.get(control) ?? []), line.box.t]);
    }
    for (const [control, tops] of rows) {
      tops.sort((x, y) => x - y);
      const count = tops.filter((t, i) => i === 0 || t - (tops[i - 1] ?? t) > 6).length;
      const row = control.parentElement?.clientWidth ?? 0;
      if (count > 1 && control.getBoundingClientRect().width < row - 1)
        out.push(`the label "${said(control.textContent ?? "")}" wraps (${name(control)})`);
    }

    const wide = document.documentElement.scrollWidth;
    const room = document.documentElement.clientWidth;
    if (wide > room) out.push(`the page is ${wide} px wide in ${room} px`);
    return out;
  });
}

/** Waits two frames, so a layout that follows a resize, a theme or a font has settled. */
export function frames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** The page holds: no faults, once whatever follows a change has had a moment to settle. */
export async function layoutHolds(page: Page, label: string) {
  await expect(async () => {
    expect(await layoutFaults(page), label).toStrictEqual([]);
  }).toPass({ timeout: 2000 });
}
