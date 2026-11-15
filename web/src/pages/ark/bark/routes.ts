import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/ark/bark/vtxo/:id", component: lazy(() => import("./VtxoPage")) },
];
