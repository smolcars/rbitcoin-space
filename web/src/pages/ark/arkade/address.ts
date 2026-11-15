// An Arkade address's page of VTXOs, as `/app/ark/arkade/address/:address?page=n` answers it, read
// strictly. The VTXOs are what an Arkade server we do not control says: checked here, shown as text.
import type { Network } from "../../../lib/network";
import { type Badge, isVtxo, type Vtxo } from "./vtxo";

export interface Listing {
  page: number;
  /** Pages arkd says the list has: 0 when it is empty. */
  pages: number;
  vtxos: Vtxo[];
}

/** The server's caps: a page of 25, and the last page it serves. */
export const PAGE_SIZE = 25;
export const MAX_PAGE = 1000;

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** The answer, or undefined if anything in it is not what the server sends. */
export function readListing(v: unknown): Listing | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const vtxos = o["vtxos"];
  const ok =
    isCount(o["page"]) &&
    o["page"] >= 1 &&
    isCount(o["pages"]) &&
    Array.isArray(vtxos) &&
    vtxos.length <= PAGE_SIZE &&
    vtxos.every((x) => isVtxo(x));
  return ok ? (o as unknown as Listing) : undefined;
}

/** What the address is, by its shape: the server checks its checksum and keys. */
export type AddressKind = "arkade" | "bark" | "unknown-version" | "other-network" | "invalid";

/**
 * BOAT-1 ("Ark address format"): the prefix is `ark` on mainnet and `tark` elsewhere; the first
 * data character is the version, `q` (0) for Arkade and `p` (1) for Bark. An Arkade address has
 * 110 data characters, its checksum's 6 among them.
 */
export function addressKind(text: string, network: Network): AddressKind {
  const m = /^(t?ark)1([02-9ac-hj-np-z]+)$/.exec(text.toLowerCase());
  if (!m?.[1] || !m[2] || (text !== text.toLowerCase() && text !== text.toUpperCase())) {
    return "invalid";
  }
  if ((m[1] === "ark") !== (network === "mainnet")) return "other-network";
  if (m[2].startsWith("p")) return "bark";
  if (!m[2].startsWith("q")) return "unknown-version";
  return m[2].length === 110 ? "arkade" : "invalid";
}

/** `?page=n` read as the server takes it; anything else is page 1. */
export function readPage(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,3}$/.test(value)) return 1;
  return Math.min(Number(value), MAX_PAGE);
}

/** Spendable as arkd reports it: neither spent nor swept. */
export const spendable = (v: Vtxo): boolean => !v.spent && !v.swept;

/** The sum of what this page lists as spendable, in sats. */
export const spendableSats = (vtxos: readonly Vtxo[]): number =>
  vtxos.filter((v) => spendable(v)).reduce((sum, v) => sum + v.amount, 0);

/** A VTXO's state in the VTXO page's words: Spent, Swept or Unspent, then Not settled yet. */
export function statusOf(v: Vtxo): Badge[] {
  const out: Badge[] = [];
  if (v.spent) out.push({ word: "Spent", tone: "neutral", icon: "arrow" });
  else if (v.swept) out.push({ word: "Swept", tone: "negative", icon: "cross" });
  else out.push({ word: "Unspent", tone: "neutral", icon: "check" });
  if (spendable(v) && v.preconfirmed) {
    out.push({ word: "Not settled yet", tone: "caution", icon: "dashed" });
  }
  return out;
}
