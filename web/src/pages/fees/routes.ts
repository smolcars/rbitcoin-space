import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/fees/score", component: lazy(() => import("./FeeScorePage")) },
];
