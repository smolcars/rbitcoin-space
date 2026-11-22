// Which implementation knows a `txid:vout` (docs/ARK.md "The entry page"): each one the network
// has is asked through its own route, at once, and the answers decide the page.
import { ApiError, fetchApp } from "../../lib/api";
import { type Network, paths } from "../../lib/network";

export interface Implementation {
  /** Its name in `/app/config`'s `ark` lists. */
  id: "bark" | "arkade";
  /** As written in the UI. */
  name: string;
  /** Its VTXO page, network-free. */
  page: (id: string) => string;
  /** Its route under `/app`. */
  route: (txid: string, vout: number) => string;
}

/** In the order the page names them. */
export const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    id: "bark",
    name: "Bark",
    page: paths.barkVtxo,
    route: (txid, vout) => `/ark/bark/vtxo/${txid}:${vout}`,
  },
  {
    id: "arkade",
    name: "Arkade",
    page: paths.arkadeVtxo,
    route: (txid, vout) => `/ark/arkade/vtxo/${txid}/${vout}`,
  },
];

/** The implementations a network has, from its `ark` list. */
export function offered(list: readonly string[] | undefined): Implementation[] {
  return IMPLEMENTATIONS.filter((i) => list?.includes(i.id) === true);
}

/** One implementation's answer: it knows the VTXO, it does not, or it could not be asked. */
export type Answer = "found" | "unknown" | "down";

/** Reads a route's answer. Bark's "did not verify" is Bark knowing it: its page says the rest. */
export function answerOf(ok: boolean, error: unknown): Answer {
  if (ok) return "found";
  if (error instanceof ApiError && error.status === 404) return "unknown";
  if (error instanceof ApiError && error.message.includes("did not verify")) return "found";
  return "down";
}

/** Asks one implementation; never throws, but rethrows an abort. */
export async function ask(
  network: Network,
  impl: Implementation,
  txid: string,
  vout: number,
  signal: AbortSignal,
): Promise<Answer> {
  try {
    await fetchApp<unknown>(network, impl.route(txid, vout), { signal, cached: true });
    return answerOf(true, undefined);
  } catch (e) {
    if (signal.aborted) throw e;
    return answerOf(false, e);
  }
}

export type Verdict =
  /** Exactly one knows it: open its page. */
  | { kind: "one"; impl: Implementation }
  /** More than one does, which should not happen: the reader picks. */
  | { kind: "many"; impls: Implementation[] }
  /** None knows it, and these could not be asked. */
  | { kind: "none"; down: Implementation[] };

export function verdict(impls: readonly Implementation[], answers: readonly Answer[]): Verdict {
  const found = impls.filter((_, i) => answers[i] === "found");
  const [first] = found;
  if (found.length === 1 && first) return { kind: "one", impl: first };
  if (found.length > 1) return { kind: "many", impls: found };
  return { kind: "none", down: impls.filter((_, i) => answers[i] === "down") };
}

/** "Bark", "Bark or Arkade", "Bark and Arkade". */
export function names(impls: readonly Implementation[], joiner: "or" | "and"): string {
  const all = impls.map((i) => i.name);
  return all.length < 2 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} ${joiner} ${all.at(-1)}`;
}
