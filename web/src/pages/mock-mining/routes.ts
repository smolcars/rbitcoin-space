// MOCKUP, never merged: the redesigned mining page on recorded sample data.
import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/mock/mining", component: lazy(() => import("./MockMining")) },
];
