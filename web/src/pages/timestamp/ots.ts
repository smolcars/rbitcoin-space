// An OpenTimestamps proof (`.ots`), read and played forward (docs/FRONTEND.md "Timestamp proofs").
// The file is hostile input: every length is checked against what is left before it is used,
// nothing is allocated from a length that was not, the tree is read with a stack of our own
// rather than by recursion, and depth, operations, attestations, message sizes and the bytes
// hashed are all bounded. Anything wrong is a `ProofError`, never another exception.
import { createHasher, DIGEST_LENGTH, type HashName, reversed, toHex } from "./hashes";

/** The file starts with these 31 bytes: a zero, "OpenTimestamps", two zeros, "Proof", a zero, 8 more. */
export const MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);

/** The bounds. A real proof is a few kilobytes, a path a few dozen steps, a message 32 to ~300 bytes. */
export const LIMITS = {
  /** The whole file. The largest real proof seen was under 4 KB. */
  proofBytes: 256 * 1024,
  /** Operations from the digest to any attestation. */
  depth: 1000,
  /** Operations in the whole tree. */
  ops: 10_000,
  attestations: 256,
  /** An append's or prepend's argument, and any message: the format's own limit. */
  message: 4096,
  /** An attestation's payload: the format's own limit. */
  payload: 8192,
  /** A calendar's address in a pending attestation. */
  uri: 1000,
  /**
   * Bytes fed to hashes while playing the proof forward. Under the bounds above a hash of a full
   * 4,096-byte message needs a leaf of its own or seven hex steps before it, so a proof can ask for
   * about 6 MiB at most; this bound is below that, so it is the one that refuses. A real proof
   * hashes a few kilobytes.
   */
  work: 4 * 1024 * 1024,
} as const;

export type ProofErrorKind =
  /** It does not start as a proof file does. */
  | "not-proof"
  /** It ends in the middle of something. */
  | "truncated"
  /** A major version other than 1. */
  | "version"
  /** A tag this page does not know, where the format gives no way to skip it. */
  | "unknown-op"
  /** Past one of `LIMITS`. */
  | "too-large"
  /** Anything else that breaks the format. */
  | "malformed";

export class ProofError extends Error {
  readonly kind: ProofErrorKind;
  constructor(kind: ProofErrorKind, message: string) {
    super(message);
    this.name = "ProofError";
    this.kind = kind;
  }
}

export interface HashOp {
  kind: HashName;
}
export type Op =
  | HashOp
  | { kind: "append" | "prepend"; arg: Uint8Array }
  | { kind: "reverse" | "hexlify" };

export type Attestation =
  | { kind: "bitcoin"; height: number }
  | { kind: "litecoin"; height: number }
  | { kind: "pending"; uri: string }
  | { kind: "unknown"; tag: string; size: number };

/** One point in the tree: what is attested to the message here, and the branches that go on. */
export interface Stamp {
  attestations: Attestation[];
  branches: { op: Op; next: Stamp }[];
}

export interface Proof {
  /** How the file is hashed: almost always SHA-256. */
  fileHash: HashName;
  digest: Uint8Array;
  stamp: Stamp;
}

const HASH_TAGS: Record<number, HashName> = {
  0x08: "sha256",
  0x02: "sha1",
  0x03: "ripemd160",
  0x67: "keccak256",
};
const APPEND = 0xf0;
const PREPEND = 0xf1;
const REVERSE = 0xf2;
const HEXLIFY = 0xf3;
const ATTESTATION = 0x00;
const FORK = 0xff;

const BITCOIN = "0588960d73d71901";
const LITECOIN = "06869a0d73d71b45";
const PENDING = "83dfe30d2ef90c8e";

/** The characters a calendar's address may have. */
const URI = /^[A-Za-z0-9\-._/:]*$/;

interface Reader {
  readonly done: () => boolean;
  readonly byte: () => number;
  readonly take: (n: number) => Uint8Array;
  /** An unsigned LEB128 integer of at most 32 bits. */
  readonly varuint: () => number;
  /** A length-prefixed byte string of at most `max` bytes. */
  readonly varbytes: (max: number, what: string) => Uint8Array;
}

function reader(bytes: Uint8Array): Reader {
  let at = 0;
  const byte = (): number => {
    const b = bytes[at];
    if (b === undefined) throw new ProofError("truncated", "The proof ends too early.");
    at++;
    return b;
  };
  const take = (n: number): Uint8Array => {
    if (n > bytes.length - at) throw new ProofError("truncated", "The proof ends too early.");
    const out = bytes.subarray(at, at + n);
    at += n;
    return out;
  };
  const varuint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = byte();
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (value > 0xffff_ffff) break;
        return value;
      }
    }
    throw new ProofError("too-large", "The proof holds a number larger than this page reads.");
  };
  return {
    done: () => at >= bytes.length,
    byte,
    take,
    varuint,
    varbytes: (max, what) => {
      const n = varuint();
      if (n > max) throw new ProofError("too-large", `${what} is longer than the format allows.`);
      return take(n);
    },
  };
}

function readAttestation(r: Reader): Attestation {
  const tag = toHex(r.take(8));
  const body = r.varbytes(LIMITS.payload, "An attestation");
  const payload = reader(body);
  let a: Attestation;
  if (tag === BITCOIN) a = { kind: "bitcoin", height: payload.varuint() };
  else if (tag === LITECOIN) a = { kind: "litecoin", height: payload.varuint() };
  else if (tag === PENDING) {
    const uri = payload.varbytes(LIMITS.uri, "A calendar's address");
    let text = "";
    for (const b of uri) text += String.fromCodePoint(b);
    if (!URI.test(text))
      throw new ProofError("malformed", "A calendar's address has characters it may not have.");
    a = { kind: "pending", uri: text };
  } else {
    // Another notary: its payload is skipped whole, and it is named, never checked.
    return { kind: "unknown", tag, size: body.length };
  }
  if (!payload.done())
    throw new ProofError("malformed", "An attestation has bytes after its value.");
  return a;
}

function readOp(r: Reader, tag: number): Op {
  const hashName = HASH_TAGS[tag];
  if (hashName) return { kind: hashName };
  if (tag === APPEND || tag === PREPEND) {
    const arg = r.varbytes(LIMITS.message, "An added value");
    // Adding nothing is no step, and lets the same proof be written in endless ways.
    if (arg.length === 0) throw new ProofError("malformed", "The proof adds an empty value.");
    return { kind: tag === APPEND ? "append" : "prepend", arg };
  }
  if (tag === REVERSE) return { kind: "reverse" };
  if (tag === HEXLIFY) return { kind: "hexlify" };
  throw new ProofError(
    "unknown-op",
    `The proof uses an operation this page does not support (tag 0x${tag.toString(16).padStart(2, "0")}).`,
  );
}

/** Reads a proof file. Throws only `ProofError`. */
export function parseProof(bytes: Uint8Array): Proof {
  if (bytes.length > LIMITS.proofBytes)
    throw new ProofError("too-large", "This file is far larger than any timestamp proof.");
  const r = reader(bytes);
  for (const m of MAGIC) {
    if (r.done() || r.byte() !== m)
      throw new ProofError("not-proof", "This is not an OpenTimestamps proof file.");
  }
  const version = r.varuint();
  if (version !== 1)
    throw new ProofError(
      "version",
      `The proof's format version (${version}) is not one this page reads.`,
    );
  const tag = r.byte();
  const fileHash = HASH_TAGS[tag];
  if (!fileHash)
    throw new ProofError(
      "unknown-op",
      `The proof hashes the file in a way this page does not support (tag 0x${tag.toString(16).padStart(2, "0")}).`,
    );
  const digest = r.take(DIGEST_LENGTH[fileHash]);

  // Each item of a stamp is an attestation or an operation followed by the stamp it leads to; a
  // fork byte before an item says another item follows it. The stack holds the stamps being read.
  const root: Stamp = { attestations: [], branches: [] };
  const stack: { stamp: Stamp; last: boolean }[] = [{ stamp: root, last: false }];
  let ops = 0;
  let attestations = 0;
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    if (top.last) {
      stack.pop();
      continue;
    }
    let t = r.byte();
    if (t === FORK) t = r.byte();
    else top.last = true;
    if (t === ATTESTATION) {
      if (++attestations > LIMITS.attestations)
        throw new ProofError("too-large", "The proof has more attestations than this page reads.");
      top.stamp.attestations.push(readAttestation(r));
      continue;
    }
    const op = readOp(r, t);
    if (++ops > LIMITS.ops)
      throw new ProofError("too-large", "The proof has more operations than this page reads.");
    if (stack.length > LIMITS.depth)
      throw new ProofError("too-large", "The proof's path is longer than this page follows.");
    const next: Stamp = { attestations: [], branches: [] };
    top.stamp.branches.push({ op, next });
    stack.push({ stamp: next, last: false });
  }
  if (!r.done()) throw new ProofError("malformed", "The proof has bytes after its end.");
  return { fileHash, digest, stamp: root };
}

/** The work an operation costs: the bytes it hashes. */
function cost(op: Op, message: Uint8Array): number {
  return op.kind in DIGEST_LENGTH ? message.length : 0;
}

/** One operation on a message. Throws `ProofError` when the result would pass the format's limit. */
export function apply(op: Op, message: Uint8Array): Uint8Array {
  if (op.kind === "append" || op.kind === "prepend") {
    if (message.length + op.arg.length > LIMITS.message)
      throw new ProofError("too-large", "A step of the proof makes a message too long.");
    const [first, second] = op.kind === "append" ? [message, op.arg] : [op.arg, message];
    const out = new Uint8Array(message.length + op.arg.length);
    out.set(first, 0);
    out.set(second, first.length);
    return out;
  }
  if (op.kind === "reverse") return reversed(message);
  if (op.kind === "hexlify") {
    if (message.length * 2 > LIMITS.message)
      throw new ProofError("too-large", "A step of the proof makes a message too long.");
    return new TextEncoder().encode(toHex(message));
  }
  const h = createHasher(op.kind);
  h.update(message);
  return h.digest();
}

/** An attestation with the message it attests and the operations that lead there from the digest. */
export interface Leaf {
  attestation: Attestation;
  message: Uint8Array;
  path: Op[];
}

/**
 * Plays the proof forward from `digest` and lists every attestation with its message. Iterative:
 * the stack is the path, at most `LIMITS.depth` long. Throws only `ProofError`. `stats.hashed` is
 * left holding the bytes hashed, for the tests that hold the bound.
 */
export function walk(
  proof: Proof,
  digest: Uint8Array = proof.digest,
  stats?: { hashed: number },
): Leaf[] {
  const leaves: Leaf[] = [];
  const path: Op[] = [];
  // Each frame is a stamp, its message, and how many of its branches have been followed.
  const stack: { stamp: Stamp; message: Uint8Array; next: number }[] = [
    { stamp: proof.stamp, message: digest, next: 0 },
  ];
  let work = 0;
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    if (top.next === 0) {
      for (const attestation of top.stamp.attestations)
        leaves.push({ attestation, message: top.message, path: [...path] });
    }
    const branch = top.stamp.branches[top.next];
    if (branch === undefined) {
      stack.pop();
      path.pop();
      continue;
    }
    top.next++;
    const hashed = work + cost(branch.op, top.message);
    if (hashed > LIMITS.work)
      throw new ProofError("too-large", "The proof asks for more hashing than this page does.");
    const message = apply(branch.op, top.message);
    // Counted once the hash is done: a refused or failed step adds nothing.
    work = hashed;
    if (stats) stats.hashed = work;
    path.push(branch.op);
    stack.push({ stamp: branch.next, message, next: 0 });
  }
  return leaves;
}

/** The messages along `path` from `digest`: one per operation, the last the attested one. */
export function playPath(digest: Uint8Array, path: readonly Op[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let m = digest;
  for (const op of path) {
    m = apply(op, m);
    out.push(m);
  }
  return out;
}
