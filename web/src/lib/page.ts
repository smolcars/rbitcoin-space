// Hooks every page uses: the current network and the document title.
import { useLocation } from "@solidjs/router";
import { type Accessor, createContext, createEffect, createMemo, useContext } from "solid-js";
import { NETWORK_NAMES, type Network, networkFromPath } from "./network";

/** Puts a part of a page on a network its path does not name (the decoder's transaction). */
export const NetworkScope = createContext<Network | null>(null);

/** The network of the page on screen, or of the `NetworkScope` around the caller. */
export function useNetwork(): Accessor<Network> {
  const scoped = useContext(NetworkScope);
  if (scoped !== null) return () => scoped;
  const location = useLocation();
  return createMemo(() => networkFromPath(location.pathname));
}

/** Sets the document title; test networks get their name in front so tabs are never ambiguous. */
export function usePageTitle(title: () => string): void {
  const network = useNetwork();
  createEffect(
    () =>
      `${network() === "mainnet" ? "" : `${NETWORK_NAMES[network()]}: `}${title()} | rbitcoin.space`,
    (text) => {
      document.title = text;
    },
  );
}
