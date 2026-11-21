// Transactions this page has tried to broadcast, by network and txid, for the life of the page
// (docs/FRONTEND.md "Privacy check"). Once tried, a transaction is never again said to be unsent,
// whatever came back and however often its view is remade. Nothing is stored past the page.
import type { Network } from "../../lib/network";

const tried = new Set<string>();

export const markAttempted = (network: Network, txid: string): void => {
  tried.add(`${network}:${txid}`);
};

export const wasAttempted = (network: Network, txid: string): boolean =>
  tried.has(`${network}:${txid}`);
