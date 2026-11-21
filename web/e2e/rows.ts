// What every list and table on the site promises, checked the same way wherever it appears.
import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

/**
 * Taps the first row of `table` at a point away from its own links and buttons, and checks it
 * opened the row's item. Shared with the Lightning lists, which run on recorded answers.
 */
export async function tapRow(page: Page, table: Locator, label: string) {
  const row = table.locator("tbody tr").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const href = await row.locator(".table__rowlink").getAttribute("href");
  expect(href, `${label}: the row leads somewhere`).not.toBeNull();
  // A point on the row that only the row's link answers: right to left, as a thumb on its figures.
  await row.scrollIntoViewIfNeeded();
  const spot = await row.evaluate((tr) => {
    const box = tr.getBoundingClientRect();
    const link = tr.querySelector(".table__rowlink");
    const y = box.top + box.height / 2;
    for (let x = Math.min(box.right, window.innerWidth) - 6; x > box.left; x -= 6) {
      if (document.elementFromPoint(x, y) === link) return { x, y };
    }
    return null;
  });
  expect(spot, `${label}: some of the row is not a link or a button`).not.toBeNull();
  await page.mouse.click(spot?.x ?? 0, spot?.y ?? 0);
  await expect(page, label).toHaveURL(new URL(href ?? "", page.url()).href);
}

/**
 * Every table on the page fits its panel, or shows that it scrolls: its cut edge fades and it
 * takes the keyboard. No header is cut, mid-word or otherwise.
 */
export async function tablesFit(page: Page, label: string) {
  await tablesSettled(page);
  await tablesFitNow(page, label);
}

/**
 * Waits until the page has fitted and marked its tables: they do that in the frame after a
 * ResizeObserver notice, so this waits for two frames in a row with no notice on what they
 * watch. Frames, not a clock: a busy runner's WebKit at phone width once took over 3 s for one.
 */
export function tablesSettled(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let quiet = 0;
        // Its first notice comes in the first frame, so it cannot settle before the page's do.
        const observer = new ResizeObserver(() => {
          quiet = 0;
        });
        for (const s of document.querySelectorAll(".table-scroll")) {
          observer.observe(s);
          if (s.firstElementChild) observer.observe(s.firstElementChild);
        }
        const tick = () => {
          quiet += 1;
          if (quiet < 3) {
            requestAnimationFrame(tick);
            return;
          }
          observer.disconnect();
          resolve();
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function tablesFitNow(page: Page, label: string) {
  const tables = await page.locator(".table-scroll").evaluateAll((all) =>
    all
      .filter((s) => s.getClientRects().length > 0)
      .map((s) => ({
        name: s.querySelector("caption")?.textContent ?? "",
        over: s.scrollWidth - s.clientWidth,
        cue: s instanceof HTMLElement && ("moreEnd" in s.dataset || "moreStart" in s.dataset),
        focusable: s.getAttribute("tabindex") === "0",
        cut: [...s.querySelectorAll("th")]
          .filter((th) => th.getClientRects().length > 0 && th.scrollWidth > th.clientWidth + 1)
          .map((th) => th.textContent),
      })),
  );
  for (const t of tables) {
    if (t.over > 1) {
      expect(t.cue && t.focusable, `${label}: "${t.name}" scrolls ${t.over} px unmarked`).toBe(
        true,
      );
    }
    expect(t.cut, `${label}: "${t.name}" cuts a header`).toStrictEqual([]);
  }
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide, `${label}: page width`).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
}

/**
 * Every amount on the page whole: a number never wraps inside itself or away from its unit (an
 * exact amount a field lets wrap breaks only at its point or before its unit), and never runs out
 * of the field that holds it into its neighbour.
 */
export async function amountsIntact(page: Page, label: string) {
  const faults = await page.evaluate(() => {
    const SELECTOR = ".amount, .fee, .num";
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(`main :is(${SELECTOR})`)) {
      // The innermost figure only, shown, with a digit in it.
      if (el.querySelector(SELECTOR) || el.getClientRects().length === 0) continue;
      // Times are phrases ("1 day 9 h ago"), free to wrap between their words.
      if (el.closest(".visually-hidden, [hidden], svg, time")) continue;
      const text = (el.textContent ?? "").trim();
      if (!/\d/.test(text)) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = [...range.getClientRects()]
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => r.top);
      tops.sort((a, b) => a - b);
      const lines = tops.filter((t, i) => i === 0 || t - (tops[i - 1] ?? t) > 6).length;
      // An exact amount that may wrap (Amount's `wrap`) breaks only after its point and before
      // its unit: its groups are joined by no-break spaces.
      // An exact Lightning figure (`Fig`) likewise breaks only before its unit.
      const fig = el.querySelector(".ln-fig__exact");
      const most = el.classList.contains("amount--wrap")
        ? 3
        : fig !== null && getComputedStyle(fig).whiteSpace !== "nowrap"
          ? 2
          : 1;
      if (lines > most) out.push(`"${text}" wraps onto ${lines} lines`);
      // Nor under a flow card's details icon, the one thing its button draws.
      const open = el.closest(".tx-flow__item")?.querySelector(".tx-flow__open svg");
      if (open) {
        const b = open.getBoundingClientRect();
        // Its visible text only: a unit kept for screen readers is drawn nowhere.
        const seen: DOMRect[] = [];
        const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = texts.nextNode(); t; t = texts.nextNode()) {
          if (t.parentElement?.closest(".visually-hidden")) continue;
          const part = document.createRange();
          part.selectNodeContents(t);
          seen.push(...part.getClientRects());
        }
        const under = seen.some(
          (r) =>
            r.width > 0 &&
            Math.min(r.right, b.right) - Math.max(r.left, b.left) > 0.5 &&
            Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0.5,
        );
        if (under) out.push(`"${text}" runs under its card's details icon`);
      }
      const cell = el.closest("td, th, dd, li") ?? el.parentElement;
      if (!cell) continue;
      const r = el.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      if (r.left < c.left - 1 || r.right > c.right + 1) {
        const where = `${cell.tagName.toLowerCase()}.${cell.className}`;
        out.push(
          `"${text}" runs out of its field (${where}: ${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(c.left)}–${Math.round(c.right)})`,
        );
      }
    }
    return out;
  });
  expect(faults, label).toStrictEqual([]);
}

/**
 * Every copy control on screen, pressed one at a time: its
 * "Copied" (or "Not copied") wholly in sight, nothing over it and not cut by the screen's edge, and
 * clear of the value it copied. Beside the button it once hid the decimals it had just copied.
 * The page must answer the copy (`navigator.clipboard` stood in for).
 */
export async function copyNotesClear(page: Page, label: string) {
  const { faults, checked } = await page.evaluate(async () => {
    const frame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    const out: string[] = [];
    let count = 0;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("main button.copy")];
    for (const b of buttons) {
      // A control on a panel that is shut is not checked.
      if (b.getClientRects().length === 0) continue;
      b.scrollIntoView({ block: "center" });
      await frame();
      const value =
        b.closest(".hash")?.querySelector(".hash__text") ??
        b.closest(".address-total")?.querySelector(".amount") ??
        b.closest(".tx-code")?.querySelector(".tx-code__text") ??
        b.closest(".ln-chan__ids dd")?.querySelector(".mono") ??
        b.closest(".ln-node-connect")?.querySelector(".mono");
      const name = b.title;
      if (!value) {
        out.push(`"${name}": a copy control whose value this check does not know`);
        continue;
      }
      // Caught as it is put in, and measured then: it shows for 1.4 s, which a slow frame (the
      // first after a change of faces, on CI's runner) can outlast between two looks.
      let watch: MutationObserver | undefined;
      const note = await new Promise<HTMLElement | null>((resolve) => {
        watch = new MutationObserver(() => {
          const n = b.querySelector<HTMLElement>(".copy__note");
          if (n) resolve(n);
        });
        watch.observe(b, { childList: true, subtree: true });
        // A ceiling for a note that never comes, so the report names it; not a measurement.
        setTimeout(() => resolve(null), 10_000);
        b.click();
      });
      watch?.disconnect();
      count += 1;
      if (!note) {
        out.push(`"${name}": no note showed`);
        continue;
      }
      const n = note.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(value);
      const over = [...range.getClientRects()].some(
        (r) =>
          Math.min(r.right, n.right) - Math.max(r.left, n.left) > 0.5 &&
          Math.min(r.bottom, n.bottom) - Math.max(r.top, n.top) > 0.5,
      );
      if (over) out.push(`"${name}": "${note.textContent}" covers the value it copied`);
      const w = document.documentElement.clientWidth;
      const h = document.documentElement.clientHeight;
      if (n.left < 0 || n.top < 0 || n.right > w || n.bottom > h) {
        out.push(`"${name}": "${note.textContent}" runs off the screen`);
      }
      // Its corners and middle are its own: nothing covers it and no scroller cuts it.
      // Inside its rounded corners, where a hit test would reach whatever lies under them.
      const [cx, cy] = [(n.left + n.right) / 2, (n.top + n.bottom) / 2];
      const points = [
        [n.left + 8, cy],
        [n.right - 8, cy],
        [cx, n.top + 3],
        [cx, n.bottom - 3],
        [cx, cy],
      ] as const;
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !note.contains(hit)) {
          const by =
            hit === null
              ? "the screen edge"
              : hit === b
                ? "its own button"
                : `${hit.tagName} ${hit.className} in ${hit.parentElement?.className ?? ""} ${hit.getAttribute("title") ?? ""}`;
          out.push(
            `"${name}": "${note.textContent}" is under ${by} at ${Math.round(x)},${Math.round(y)}`,
          );
          break;
        }
      }
      // Out of the way of the next control's note; the button takes its own away after 1.4 s.
      note.style.visibility = "hidden";
    }
    return { faults: out, checked: count };
  });
  expect(faults, label).toStrictEqual([]);
  expect(checked, `${label}: copy controls checked`).toBeGreaterThan(0);
}

/** Wider fallback faces, as a Linux machine without the system fonts this was built on draws. */
export async function wideFaces(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty("--font-sans", '"DejaVu Sans", Verdana, sans-serif');
    root.setProperty("--font-mono", '"DejaVu Sans Mono", "Courier New", monospace');
  });
}

/**
 * What is cut in the rows of every table under `scope`: each run of text, measured as drawn, must
 * lie inside the table's box and inside every box that clips it (an ellipsis included), and the
 * table must not scroll or fade at its edge. An id cut in the middle by design is judged by its
 * own box instead.
 */
export async function rowFaults(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const inside = (r: DOMRect, box: DOMRect) =>
      r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    for (const scroll of document.querySelectorAll<HTMLElement>(`${sel} .table-scroll`)) {
      if (scroll.getClientRects().length === 0) continue;
      const name = scroll.querySelector("caption")?.textContent ?? "";
      if ("moreEnd" in scroll.dataset) out.push(`${name}: fades at its edge`);
      const edge = scroll.getBoundingClientRect();
      const body = scroll.querySelector("tbody");
      if (!body) continue;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? "").trim();
        const parent = node.parentElement;
        if (!text || !parent || parent.getClientRects().length === 0) continue;
        if (parent.closest(".visually-hidden")) continue;
        const hash = parent.closest(".hash");
        if (hash) {
          if (!inside(hash.getBoundingClientRect(), edge))
            out.push(`${name}: id "${text}" past the edge`);
          continue;
        }
        // The table's box, and every box between the text and it that clips what overflows.
        const boxes = [edge];
        for (let a: HTMLElement | null = parent; a && a !== scroll; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== "visible") boxes.push(a.getBoundingClientRect());
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.width === 0) continue;
          if (!boxes.every((box) => inside(r, box))) {
            out.push(`${name}: "${text}" is cut`);
            break;
          }
        }
      }
    }
    return out;
  }, scope);
}

/** Every row under `scope` whole ({@link rowFaults}), once the tables have settled. */
export async function rowsWhole(page: Page, scope: string, label: string) {
  await expect(async () => {
    expect(await rowFaults(page, scope), label).toStrictEqual([]);
  }).toPass({ timeout: 3000 });
}
