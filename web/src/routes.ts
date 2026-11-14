// The route table. Each page declares its own routes in pages/<page>/routes.ts; add new pages here once.
import type { RouteDefinition } from "@solidjs/router";
import { routes as address } from "./pages/address/routes";
import { routes as block } from "./pages/block/routes";
import { routes as blocks } from "./pages/blocks/routes";
import { routes as home } from "./pages/home/routes";
import { routes as lightning } from "./pages/lightning/routes";
import { routes as mempool } from "./pages/mempool/routes";
import { routes as mining } from "./pages/mining/routes";
import { routes as notFound } from "./pages/not-found/routes";
import { routes as projected } from "./pages/projected/routes";
import { routes as tx } from "./pages/tx/routes";

/** Every page, on every network: mainnet at the root, the others under their prefix. */
export const routes: RouteDefinition[] = [
  {
    path: ["/", "/signet", "/testnet4", "/testnet5", "/regtest"],
    children: [
      ...home,
      ...projected,
      ...block,
      ...blocks,
      ...tx,
      ...address,
      ...mining,
      ...lightning,
      ...mempool,
      ...notFound,
    ],
  },
];
