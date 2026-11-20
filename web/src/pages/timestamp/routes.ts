import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/timestamp", component: lazy(() => import("./TimestampPage")) },
];
