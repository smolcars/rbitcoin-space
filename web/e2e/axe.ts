// axe-core in the page, for the accessibility pass (a11y.e2e.ts) and the pages that check their
// own states (timestamp.e2e.ts). axe-core is a development dependency only: read from
// node_modules and run in the page through Playwright, never bundled or served.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** WCAG 2.0 to 2.2, A and AA, and axe's best practices. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OFF = {
  // A tile's name starts with the title in sight ("Block 110", "Next block"), as WCAG 2.5.3 asks;
  // the rule wants every figure drawn in the tile in its name, in the order drawn.
  "label-content-name-mismatch": { enabled: false },
};

interface Violation {
  id: string;
  nodes: { target: string[]; failureSummary?: string }[];
}

/** axe-core's violations on the page as it is now, one line each. */
export async function axe(page: Page, only?: string[]): Promise<string[]> {
  // Fades still under way (they remain under reduced motion) would be measured half done.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.evaluate(AXE);
  const found = await page.evaluate(
    async ({ tags, rules, only: ids }) => {
      const run = (window as unknown as { axe: { run: (...a: unknown[]) => Promise<unknown> } }).axe
        .run;
      const r = (await run(document, {
        runOnly: ids ? { type: "rule", values: ids } : { type: "tag", values: tags },
        rules: ids ? {} : rules,
        resultTypes: ["violations"],
      })) as { violations: Violation[] };
      return r.violations;
    },
    { tags: TAGS, rules: OFF, only },
  );
  return found.flatMap((v) =>
    v.nodes.map((n) => `${v.id} at ${n.target.join(" ")}: ${n.failureSummary ?? ""}`),
  );
}
