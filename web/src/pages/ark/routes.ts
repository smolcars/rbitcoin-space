import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";
import { routes as arkade } from "./arkade/routes";
import { routes as bark } from "./bark/routes";

export const routes: RouteDefinition[] = [
  { path: "/ark", component: lazy(() => import("./ArkPage")) },
  ...bark,
  ...arkade,
];
