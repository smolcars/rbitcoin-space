import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/ark/arkade/vtxo/:outpoint", component: lazy(() => import("./VtxoPage")) },
];
