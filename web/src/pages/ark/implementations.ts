// The Ark implementations the site has pages for. The server says which of them each network
// looks VTXOs up on (`/app/config`'s `ark`); the entry page offers those, in this order.
import { paths } from "../../lib/network";

export interface ArkImplementation {
  /** Its name in the server's `ark` list and in paths. */
  id: string;
  /** As written in the UI. */
  name: string;
  /** A VTXO's page, network-free. */
  vtxo: (id: string) => string;
}

export const IMPLEMENTATIONS: readonly ArkImplementation[] = [
  { id: "bark", name: "Bark", vtxo: paths.barkVtxo },
  { id: "arkade", name: "Arkade", vtxo: paths.arkadeVtxo },
];

/** The implementations a network has, in the list's order. */
export function offered(names: readonly string[] | undefined): ArkImplementation[] {
  return IMPLEMENTATIONS.filter((i) => names?.includes(i.id) === true);
}
