// What the Ark entry page needs to offer Arkade beside the other implementations: a label, the
// placeholder for its paste box, a strict parser, and where a parsed outpoint leads.
import { type Outpoint, parseOutpoint } from "./vtxo";

/** The network-free path of an Arkade VTXO's page. Only a parsed outpoint gets here: hex and digits. */
export function arkadeVtxoPath(o: Outpoint): string {
  return `/ark/arkade/vtxo/${o.txid}:${o.vout}`;
}

/**
 * One entry for the Ark entry page's list (`{ id, name, vtxo }`), with a strict parser and a
 * placeholder for its paste box. `vtxo` takes the pasted text: an outpoint leads to its page, and
 * anything else to the page's own "Not a VTXO", through a fixed segment no text can change.
 */
export const arkadeEntry = {
  id: "arkade",
  name: "Arkade",
  label: "Arkade",
  placeholder: "txid:vout",
  parse: (text: string): Outpoint | undefined => parseOutpoint(text.trim()),
  href: arkadeVtxoPath,
  vtxo: (text: string): string => {
    const o = parseOutpoint(text.trim());
    return o ? arkadeVtxoPath(o) : "/ark/arkade/vtxo/not-an-outpoint";
  },
} as const;
