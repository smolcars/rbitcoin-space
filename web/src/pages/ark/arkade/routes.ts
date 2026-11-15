import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/ark/arkade/vtxo/:outpoint", component: lazy(() => import("./VtxoPage")) },
  { path: "/ark/arkade/address/:address", component: lazy(() => import("./AddressPage")) },
];
