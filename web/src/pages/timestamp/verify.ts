// From a read proof and the reader's digest to a verdict. Only Bitcoin attestations are checked,
// and only against the block the node has at their height: its header, whose hash is checked
// against the hash the node named, and whose merkle root is compared byte for byte with the
// message the proof's path ends in. The header holds the root in the order the proof commits to;
// the API's `merkle_root` text is the same 32 bytes reversed, so it is never used here.
import { hash, reversed, toHex } from "./hashes";
import { type Attestation, type Leaf, type Op, playPath, type Proof, walk } from "./ots";

/** A block as its header gives it. `merkleRoot` is in the header's own byte order. */
export interface Block {
  height: number;
  hash: string;
  merkleRoot: Uint8Array;
  time: number;
}

/** A block by height, or null when the node has none there. Rejects on any other failure. */
export type FetchBlock = (height: number, signal: AbortSignal) => Promise<Block | null>;

/** One Bitcoin attestation, checked. */
export type Check =
  | { kind: "verified"; leaf: Leaf; height: number; block: Block }
  | { kind: "mismatch"; leaf: Leaf; height: number; block: Block }
  | { kind: "missing"; leaf: Leaf; height: number };

export type Verdict =
  /** The digest leads to the merkle root of `check.block`, the earliest such. */
  | { kind: "verified"; check: Check & { kind: "verified" }; checks: Check[]; others: Leaf[] }
  /** The reader's digest is not the proof's. Nothing was asked. */
  | { kind: "wrong-file"; proofDigest: Uint8Array; fileDigest: Uint8Array }
  /** No attestation verified and at least one led somewhere other than its block's root. */
  | { kind: "broken"; checks: Check[]; others: Leaf[] }
  /** Every Bitcoin attestation names a block the node does not have. */
  | { kind: "unknown-block"; checks: Check[]; others: Leaf[] }
  /** No Bitcoin attestation, and at least one calendar's promise. */
  | { kind: "pending"; calendars: string[]; others: Leaf[] }
  /** No Bitcoin attestation and no calendar: only notaries this page does not check. */
  | { kind: "no-bitcoin"; others: Leaf[] }
  /** The server has no mainnet, so no block can be asked for. */
  | { kind: "no-mainnet"; heights: number[]; others: Leaf[] };

/** At most this many distinct Bitcoin attestations are asked about; real proofs have one to four. */
export const MAX_CHECKS = 8;

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The 80-byte header's hash as the node writes it: double SHA-256, bytes reversed. */
export function headerHash(header: Uint8Array): string {
  return toHex(reversed(hash("sha256", hash("sha256", header))));
}

/**
 * A block from the node's hash for a height and its header in hex. Null unless the header is 80
 * bytes and hashes to that hash, so a reply that is not the block asked for is never used.
 */
export function readHeader(height: number, blockHash: string, headerHex: string): Block | null {
  if (!/^[0-9a-f]{64}$/.test(blockHash) || !/^[0-9a-f]{160}$/.test(headerHex)) return null;
  const header = new Uint8Array(80);
  for (let i = 0; i < 80; i++) header[i] = Number.parseInt(headerHex.slice(i * 2, i * 2 + 2), 16);
  if (headerHash(header) !== blockHash) return null;
  const time = new DataView(header.buffer).getUint32(68, true);
  return { height, hash: blockHash, merkleRoot: header.slice(36, 68), time };
}

const isBitcoin = (l: Leaf): l is Leaf & { attestation: { kind: "bitcoin"; height: number } } =>
  l.attestation.kind === "bitcoin";

/**
 * The verdict for `proof` and the reader's `digest`. `fetchBlock` is called only after the digest
 * matched, only for Bitcoin attestations, lowest height first, at most `MAX_CHECKS` times, one at a
 * time; never when `mainnet` is false. Rejects with `ProofError` if the proof cannot be played
 * forward, and with whatever `fetchBlock` rejects with.
 */
export async function verify(
  proof: Proof,
  digest: Uint8Array,
  options: { mainnet: boolean; fetchBlock: FetchBlock; signal: AbortSignal },
): Promise<Verdict> {
  if (!equal(digest, proof.digest))
    return { kind: "wrong-file", proofDigest: proof.digest, fileDigest: digest };
  const leaves = walk(proof, digest);
  const others = leaves.filter((l) => !isBitcoin(l));
  // The same height and message reached by two branches is one question.
  const seen = new Set<string>();
  const bitcoin = leaves
    .filter((l) => isBitcoin(l))
    .filter((l) => {
      const key = `${l.attestation.height}:${toHex(l.message)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts the array filter made; toSorted is past this lib target
    .sort((a, b) => a.attestation.height - b.attestation.height);
  if (bitcoin.length === 0) {
    const calendars = others.flatMap((l) =>
      l.attestation.kind === "pending" ? [l.attestation.uri] : [],
    );
    return calendars.length > 0
      ? { kind: "pending", calendars: [...new Set(calendars)], others }
      : { kind: "no-bitcoin", others };
  }
  if (!options.mainnet)
    return {
      kind: "no-mainnet",
      heights: [...new Set(bitcoin.map((l) => l.attestation.height))],
      others,
    };
  const checks: Check[] = [];
  for (const leaf of bitcoin.slice(0, MAX_CHECKS)) {
    const height = leaf.attestation.height;
    // oxlint-disable-next-line no-await-in-loop -- one block at a time, to ask the node no more than needed
    const block = await options.fetchBlock(height, options.signal);
    if (block === null) checks.push({ kind: "missing", leaf, height });
    else if (equal(leaf.message, block.merkleRoot))
      checks.push({ kind: "verified", leaf, height, block });
    else checks.push({ kind: "mismatch", leaf, height, block });
  }
  const verified = checks.find((c) => c.kind === "verified");
  if (verified) return { kind: "verified", check: verified, checks, others };
  if (checks.some((c) => c.kind === "mismatch")) return { kind: "broken", checks, others };
  return { kind: "unknown-block", checks, others };
}

/** One step of the path as the page lists it. */
export interface Step {
  op: Op;
  result: Uint8Array;
  /** Set on the step whose result is the transaction that carries the commitment. */
  txid?: string;
  /** Set on the first step of the block's merkle branch: how many levels it climbs. */
  branch?: number;
  /** A level of the merkle branch, its sibling joined and hashed twice in one step. */
  level?: true;
}

/**
 * The path from the digest to `leaf`, with the transaction and the merkle branch marked where the
 * path has their shape: a message longer than 64 bytes hashed twice (a transaction, its id the
 * result reversed), then only pairs of a 32-byte prepend or append and a double SHA-256 up to the
 * end, each level of which is folded into one step. Marks are labels for the reader; the verdict
 * never rests on them.
 */
export function steps(digest: Uint8Array, leaf: Leaf): Step[] {
  const results = playPath(digest, leaf.path);
  const out: Step[] = leaf.path.map((op, i) => ({ op, result: results[i] ?? new Uint8Array() }));
  const path = leaf.path;
  // The branch: from the end, triples of (prepend or append 32 bytes, sha256, sha256).
  let start = path.length;
  while (start >= 3) {
    const [join, h1, h2] = [path[start - 3], path[start - 2], path[start - 1]];
    const isJoin = (join?.kind === "prepend" || join?.kind === "append") && join.arg.length === 32;
    if (!isJoin || h1?.kind !== "sha256" || h2?.kind !== "sha256") break;
    start -= 3;
  }
  // The transaction: two SHA-256 steps just before the branch, of a message over 64 bytes.
  const tx = start - 1;
  const input = tx === 1 ? digest : results[tx - 2];
  if (
    tx >= 1 &&
    path[tx]?.kind === "sha256" &&
    path[tx - 1]?.kind === "sha256" &&
    input !== undefined &&
    input.length > 64
  ) {
    const s = out[tx];
    if (s) s.txid = toHex(reversed(s.result));
    // Each level of the branch is one step: the join, with the result of its two hashes.
    const levels: Step[] = [];
    for (let i = start; i + 2 < path.length; i += 3) {
      const join = path[i];
      const result = results[i + 2];
      if (join && result) levels.push({ op: join, result, level: true });
    }
    const first = levels[0];
    if (first) first.branch = levels.length;
    return [...out.slice(0, start), ...levels];
  }
  return out;
}

/** The attestation's words, for the list of what else the proof holds. */
export function attestationName(a: Attestation): string {
  return ATTESTATION_NAMES[a.kind];
}

const ATTESTATION_NAMES: Record<Attestation["kind"], string> = {
  bitcoin: "Bitcoin block",
  litecoin: "Litecoin block",
  pending: "Calendar's promise",
  unknown: "Another notary",
};
