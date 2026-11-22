// The newest block at or before a typed moment (`readDate`), asked of the server's block table.
// Shared by the palette's "Go to a date" and the address page's block field.
import { ApiError, fetchApi, isNotFound } from "../lib/api";
import type { Network } from "../lib/network";
import type { Moment } from "./match";

export interface Found {
  height: number;
  hash: string;
}

/** What a date's lookup came to: its block, or why there is none to show. */
export type Dated =
  | { kind: "found"; found: Found }
  /** The server's block history has nothing at or before then: too early, or not indexed. */
  | { kind: "none" }
  | { kind: "failed"; message: string };

const isFound = (v: unknown): v is Found =>
  typeof v === "object" &&
  v !== null &&
  "height" in v &&
  typeof v.height === "number" &&
  "hash" in v &&
  typeof v.hash === "string" &&
  /^[0-9a-f]{64}$/.test(v.hash);

/** The block at a moment; rejects only when `signal` aborts. */
export async function blockAt(moment: Moment, net: Network, signal: AbortSignal): Promise<Dated> {
  try {
    const body = await fetchApi<unknown>(net, `/v1/mining/blocks/timestamp/${moment.at}`, {
      signal,
      cached: true,
    });
    return isFound(body)
      ? { kind: "found", found: body }
      : { kind: "failed", message: "The server's answer could not be read" };
  } catch (error) {
    if (signal.aborted) throw error;
    if (isNotFound(error)) return { kind: "none" };
    return {
      kind: "failed",
      message: error instanceof ApiError ? error.message : "The lookup could not finish",
    };
  }
}
