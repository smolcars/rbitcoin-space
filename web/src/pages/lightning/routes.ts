import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

export const routes: RouteDefinition[] = [
  { path: "/lightning", component: lazy(() => import("./LightningPage")) },
  { path: "/lightning/node/:key", component: lazy(() => import("./NodePage")) },
  { path: "/lightning/channel/:id", component: lazy(() => import("./ChannelPage")) },
  { path: "/lightning/search", component: lazy(() => import("./SearchPage")) },
  { path: "/lightning/rankings", component: lazy(() => import("./RankingsPage")) },
  { path: "/lightning/penalties", component: lazy(() => import("./PenaltiesPage")) },
];
