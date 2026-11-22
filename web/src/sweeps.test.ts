// @vitest-environment node
// Every page the site serves has an entry in e2e/pages.ts, the list the browser rule sweeps
// (fonts, targets, a11y) walk, so no page ships unswept. The list is the module the sweeps import,
// loaded in Node as Playwright loads it: the DOM environment turns its fixtures' file URLs into
// asset URLs.
import { createRouter, type RouteDefinition, type RouteInfo } from "@solidjs/router";
import { describe, expect, it } from "vitest";
import { href, PAGES as DOCS } from "./docs/pages";
import { routes } from "./routes";

/** The app's route table, and the public docs: one template, so one page. */
const SITE: RouteDefinition[] = [...routes, { path: DOCS.map((d) => href(d.slug)) }];

// By glob, so the app's type check does not take in the browser tests' files.
const LIST = import.meta.glob<{ PAGES: readonly { path: string }[] }>("../e2e/pages.ts", {
  eager: true,
});

/** Pages left out of the sweeps, by a path their route gives on regtest, each with the reason. */
const UNSWEPT: Readonly<Record<string, string>> = {};

const pathsOf = (def: RouteDefinition): string[] => {
  const path: unknown = def.path;
  if (Array.isArray(path)) return path.map(String);
  return [typeof path === "string" ? path : ""];
};

const join = (base: string, path: string) => `${base}/${path}`.replaceAll(/\/+/g, "/");

/**
 * `table` with each page's route marked by an `info` of its own, which a match hands back, so two
 * routes with one path under different parents stay two. `leaves` gets each mark's whole paths,
 * on regtest where a group has a prefix for it, as the sweeps open them.
 */
function marked(
  table: readonly RouteDefinition[],
  leaves: Map<RouteInfo, string[]>,
  base = "",
): RouteDefinition[] {
  return table.map((def) => {
    const paths = pathsOf(def);
    const { children } = def;
    if (typeof children === "function") throw new TypeError(`${paths[0] ?? ""}: lazy children`);
    const kids = children === undefined ? [] : [children].flat();
    if (kids.length === 0) {
      const info: RouteInfo = {};
      leaves.set(
        info,
        paths.map((p) => join(base, p)),
      );
      return { ...def, info };
    }
    const prefix = paths.includes("/regtest") ? "/regtest" : (paths[0] ?? "");
    return { ...def, children: marked(kids, leaves, join(base, prefix)) };
  });
}

/** What keeps `table` from being swept whole by `swept`, given what `unswept` excludes, in words. */
function faults(
  table: readonly RouteDefinition[],
  swept: readonly string[],
  unswept: Readonly<Record<string, string>>,
): string[] {
  const leaves = new Map<RouteInfo, string[]>();
  const router = createRouter({ routes: marked(table, leaves) });
  const reached = new Set(swept.map((path) => router.match(path).at(-1)?.info));
  const out: string[] = [];
  for (const [mark, paths] of leaves) {
    const excluded = paths.find((p) => p in unswept);
    const example = (paths[0] ?? "").replaceAll(/[:*](\w+)/g, "<$1>");
    const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
    if (!reached.has(mark) && excluded === undefined) {
      out.push(
        `${paths.slice(0, 3).join(", ")}${more}: no page in e2e/pages.ts. Add { path: "${example}" } to PAGES, with what it needs stubbed, or name it in UNSWEPT (src/sweeps.test.ts) with why it is not swept.`,
      );
    }
    if (reached.has(mark) && excluded !== undefined) {
      out.push(`${excluded}: in UNSWEPT, but PAGES sweeps it. Drop it from UNSWEPT.`);
    }
  }
  const all = new Set([...leaves.values()].flat());
  for (const path of Object.keys(unswept)) {
    if (!all.has(path)) {
      out.push(`${path}: in UNSWEPT, but no route has that path. Drop it from UNSWEPT.`);
    }
  }
  return out;
}

describe("the browser sweeps' pages", () => {
  const swept = (Object.values(LIST)[0]?.PAGES ?? []).map((p) => p.path);

  it("read the list", () => {
    expect(swept.length).toBeGreaterThan(30);
    expect(swept.filter((p) => typeof p !== "string" || !p.startsWith("/"))).toStrictEqual([]);
  });

  it("cover every route", () => {
    expect(faults(SITE, swept, UNSWEPT)).toStrictEqual([]);
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
    const pages = ["/regtest/", "/signet/blocks/5", "/regtest/tx/0#x", "/decode", "/regtest/x/y"];
    expect(
      faults(table, pages, {
        "/regtest/timestamp": "a reason",
        "/regtest/*404": "a reason",
        "/gone": "a reason",
      }),
    ).toStrictEqual([
      '/regtest/tx/push: no page in e2e/pages.ts. Add { path: "/regtest/tx/push" } to PAGES, with what it needs stubbed, or name it in UNSWEPT (src/sweeps.test.ts) with why it is not swept.',
      "/regtest/*404: in UNSWEPT, but PAGES sweeps it. Drop it from UNSWEPT.",
      "/gone: in UNSWEPT, but no route has that path. Drop it from UNSWEPT.",
    ]);
  });

  it("tell apart two routes with one path under different parents", () => {
    const table: RouteDefinition[] = [
      { path: ["/", "/regtest"], children: [{ path: "/blocks" }, { path: "*404" }] },
      { path: "/archive", children: [{ path: "/blocks" }, { path: "*404" }] },
    ];
    expect(faults(table, ["/regtest/blocks", "/regtest/x/y"], {})).toStrictEqual([
      '/archive/blocks: no page in e2e/pages.ts. Add { path: "/archive/blocks" } to PAGES, with what it needs stubbed, or name it in UNSWEPT (src/sweeps.test.ts) with why it is not swept.',
      '/archive/*404: no page in e2e/pages.ts. Add { path: "/archive/<404>" } to PAGES, with what it needs stubbed, or name it in UNSWEPT (src/sweeps.test.ts) with why it is not swept.',
    ]);
  });
});
