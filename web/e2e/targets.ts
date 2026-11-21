// The thumb's-target check (docs/DESIGN.md "Touch"), shared by targets.e2e.ts and the pages that
// measure what opens on them.
import type { Page } from "@playwright/test";

/** The least a target measures each way, `--touch`. */
const TOUCH = 44;
/** A number link in the privacy check's sentences: a link in running text, held to WCAG 2.2's
 * 24 px rather than a thumb's 44 (docs/DESIGN.md "Transaction"). */
const IN_TEXT = 24;

/**
 * Every control in `scope` that is in sight and smaller than a thumb, in words, each scrolled to
 * the middle of the window first unless `scroll` is false. The exceptions the design means
 * (docs/DESIGN.md "Touch") are listed in the walk.
 */
export function smallTargets(page: Page, scope: string, scroll = true): Promise<string[]> {
  return page.evaluate(
    ({ within, touch, inText, move }) => {
      const CONTROL =
        "a[href], button, summary, input, select, textarea, [role='slider'], [role='tab']";
      const out: string[] = [];
      const said = (el: Element) => {
        const t = (el.getAttribute("aria-label") ?? el.textContent ?? "")
          .replaceAll(/\s+/g, " ")
          .trim();
        const what = t.length > 30 ? `${t.slice(0, 29)}…` : t;
        return `${el.tagName.toLowerCase()}${el.classList.length > 0 ? `.${[...el.classList].join(".")}` : ""} "${what}"`;
      };
      // The control a tap at a point reaches; a link to the same place counts as the same target
      // (a list's row opens the item its first cell's link opens).
      const reaches = (c: Element, x: number, y: number) => {
        const hit = document.elementFromPoint(x, y)?.closest(CONTROL);
        if (!hit) return false;
        if (hit === c) return true;
        return (
          c instanceof HTMLAnchorElement && hit instanceof HTMLAnchorElement && hit.href === c.href
        );
      };
      const controls = document.querySelectorAll(`:is(${within}) :is(${CONTROL})`);
      for (const c of controls) {
        if (!c.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        // Hidden from screen readers too: a list row's own link, the row's target, which its
        // cells' links sit on.
        if (c.closest(".visually-hidden, [inert], [aria-hidden='true']")) continue;
        if (c.matches(":disabled") || getComputedStyle(c).pointerEvents === "none") continue;
        // A link in a sentence: words beside it in its own line of text.
        if (
          getComputedStyle(c).display === "inline" &&
          [...(c.parentElement?.childNodes ?? [])].some(
            (n) => n instanceof Text && /\w/.test(n.data),
          )
        ) {
          continue;
        }
        // A phone's flow card: three lines, one control on each; its address and where it was
        // spent are also in the inspector its details button opens, each a target of its own. So
        // their size is meant, but no neighbour may cover them.
        // A node's channel card is the same: its peer and its channel on its first line are also
        // under its chevron (policies-node.e2e.ts).
        const small =
          (c.closest(".tx-flow__item") !== null && !c.matches(".tx-flow__open, .tx-flow__more")) ||
          c.closest(".ln-node-card__id") !== null;
        // A pop-up closes on a scroll, and it opened in sight.
        if (move) c.scrollIntoView({ block: "center", inline: "center" });
        const r = c.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // Out of sight wherever the page scrolls: the skip link until it has focus.
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (!reaches(c, x, y)) {
          const over = document.elementFromPoint(x, y);
          out.push(`${said(c)} is under ${over ? said(over) : "nothing"} at its centre`);
          continue;
        }
        if (small) {
          // Its edges too: a neighbour's target can reach over part of it and miss its centre.
          for (const [ex, ey] of [
            [x, r.top + 1],
            [x, r.bottom - 1],
            [r.left + 1, y],
            [r.right - 1, y],
          ] as const) {
            if (reaches(c, ex, ey)) continue;
            const over = document.elementFromPoint(ex, ey);
            out.push(`${said(c)} is partly under ${over ? said(over) : "nothing"}`);
            break;
          }
          continue;
        }
        // How far a tap still reaches it each way from its centre, and what a tap past that finds.
        const need = c.matches(".pv-ref") ? inText : touch;
        const stops: string[] = [];
        const reach = (dx: number, dy: number) => {
          let n = 0;
          while (n < need && reaches(c, x + dx * (n + 1), y + dy * (n + 1))) n++;
          if (n < need) {
            const past = document.elementFromPoint(x + dx * (n + 1), y + dy * (n + 1));
            stops.push(past ? said(past) : "the window's edge");
          }
          return n;
        };
        // The centre's own pixel, and a pixel's grace for a box at a fraction of one.
        const w = reach(-1, 0) + reach(1, 0) + 2;
        const h = reach(0, -1) + reach(0, 1) + 2;
        if (w < need || h < need) {
          out.push(`${said(c)} is ${w} × ${h} px, stopped by ${[...new Set(stops)].join(", ")}`);
        }
      }
      if (move) window.scrollTo(0, 0);
      return out;
    },
    { within: scope, touch: TOUCH, inText: IN_TEXT, move: scroll },
  );
}
