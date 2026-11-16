import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

/** One page for every network, so it sits outside the network prefixes (src/routes.ts). */
export const routes: RouteDefinition[] = [
  { path: "/decode", component: lazy(() => import("./DecodePage")) },
];
