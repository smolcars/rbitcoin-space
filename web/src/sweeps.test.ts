// Every page the site serves has an entry in e2e/pages.ts, the list the browser rule sweeps
// (fonts, targets, a11y) walk, so no page ships unswept. The list is read as text, as
// docs/coverage.test.ts reads the docs: it imports Playwright, which a unit test cannot load.
import { createRouter, type RouteDefinition } from "@solidjs/router";
import { describe, expect, it } from "vitest";
import { href, PAGES as DOCS } from "./docs/pages";
import { routes } from "./routes";

/** The app's route table, and the public docs: one template, so one page. */
const SITE: RouteDefinition[] = [...routes, { path: DOCS.map((d) => href(d.slug)) }];

const LIST = import.meta.glob<string>("../e2e/pages.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Pages left out of the sweeps, by a path their definition gives, each with the reason. */
const UNSWEPT: Readonly<Record<string, string>> = {};

/** The paths of `PAGES`, each `${…}` read as one segment, as a route's parameter takes it. */
function sweptPaths(source: string): string[] {
  const start = source.indexOf("export const PAGES");
  const end = source.indexOf("\n];", start);
  if (start === -1 || end === -1) throw new Error("e2e/pages.ts: no PAGES list found");
  return [...source.slice(start, end).matchAll(/\bpath: (["`])(.*?)\1/g)].map((m) =>
    (m[2] ?? "").replaceAll(/\$\{[^}]*\}/g, "0"),
  );
}

interface Leaf {
  /** Its definition's paths, as a match names them: one page, however many paths reach it. */
  paths: string[];
  /** Where a sweep on regtest opens it. */
  at: string;
}

const pathsOf = (def: RouteDefinition): string[] => {
  const path: unknown = def.path;
  if (Array.isArray(path)) return path.map(String);
  return [typeof path === "string" ? path : ""];
};

const join = (base: string, path: string) => `${base}/${path}`.replaceAll(/\/+/g, "/");

function leaves(table: readonly RouteDefinition[], base = ""): Leaf[] {
  return table.flatMap((def) => {
    const paths = pathsOf(def);
    const { children } = def;
    if (children === undefined) return [{ paths, at: join(base, paths[0] ?? "") }];
    if (typeof children === "function") throw new TypeError(`${paths[0] ?? ""}: lazy children`);
    // The sweeps run on regtest, under its prefix where a group has one.
    const prefix = paths.includes("/regtest") ? "/regtest" : (paths[0] ?? "");
    return leaves([children].flat(), join(base, prefix));
  });
}

/** What keeps `table` from being swept whole by `swept`, given what `unswept` excludes, in words. */
function faults(
  table: readonly RouteDefinition[],
  swept: readonly string[],
  unswept: Readonly<Record<string, string>>,
): string[] {
  const router = createRouter({ routes: [...table] });
  const reached = new Set(swept.map((path) => router.match(path).at(-1)?.path));
  const all = leaves(table);
  const out: string[] = [];
  for (const leaf of all) {
    const excluded = leaf.paths.find((p) => p in unswept);
    const isSwept = leaf.paths.some((p) => reached.has(p));
    const example = leaf.at.replaceAll(/[:*](\w+)/g, "<$1>");
    const more = leaf.paths.length > 3 ? ` and ${leaf.paths.length - 3} more` : "";
    if (!isSwept && excluded === undefined) {
      out.push(
        `${leaf.paths.slice(0, 3).join(", ")}${more}: no page in e2e/pages.ts. Add { path: "${example}" } to PAGES, with what it needs stubbed, or name it in UNSWEPT (src/sweeps.test.ts) with why it is not swept.`,
      );
    }
    if (isSwept && excluded !== undefined) {
      out.push(`${excluded}: in UNSWEPT, but PAGES sweeps it. Drop it from UNSWEPT.`);
    }
  }
  for (const path of Object.keys(unswept)) {
    if (!all.some((leaf) => leaf.paths.includes(path))) {
      out.push(`${path}: in UNSWEPT, but no route has that path. Drop it from UNSWEPT.`);
    }
  }
  return out;
}

describe("the browser sweeps' pages", () => {
  const source = Object.values(LIST)[0] ?? "";

  it("read the list", () => {
    expect(sweptPaths(source).length).toBeGreaterThan(30);
  });

  it("cover every route", () => {
    expect(faults(SITE, sweptPaths(source), UNSWEPT)).toStrictEqual([]);
  });

  it("name a route with no page, and an exclusion that no longer holds", () => {
    const table: RouteDefinition[] = [
      { path: "/decode" },
      {
        path: ["/", "/signet", "/regtest"],
        children: [
          { path: "/" },
          { path: ["/blocks", "/blocks/:from"] },
          { path: "/tx/push" },
          { path: "/tx/:txid" },
          { path: "/timestamp" },
          { path: "*404" },
        ],
      },
    ];
    const swept = ["/regtest/", "/signet/blocks/5", "/regtest/tx/0#x", "/decode", "/regtest/x/y"];
    expect(
      faults(table, swept, { "/timestamp": "a reason", "*404": "a reason", "/gone": "a reason" }),
    ).toStrictEqual([
      '/tx/push: no page in e2e/pages.ts. Add { path: "/regtest/tx/push" } to PAGES, with what it needs stubbed, or name it in UNSWEPT (src/sweeps.test.ts) with why it is not swept.',
      "*404: in UNSWEPT, but PAGES sweeps it. Drop it from UNSWEPT.",
      "/gone: in UNSWEPT, but no route has that path. Drop it from UNSWEPT.",
    ]);
  });
});
