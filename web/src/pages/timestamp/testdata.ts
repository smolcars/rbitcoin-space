// Real proofs and blocks from fixtures/ots, and a small writer of proofs for the tests' own cases.
import { fromHex } from "./hashes";
import { MAGIC } from "./ots";
import { type Block, readHeader } from "./verify";

const FILES = import.meta.glob<string>("../../../../fixtures/ots/*.ots", {
  eager: true,
  query: "?inline",
  import: "default",
});

/** A proof file from fixtures/ots by name: `two-blocks`, `pending`. */
export function fixture(name: string): Uint8Array {
  const url = FILES[`../../../../fixtures/ots/${name}.ots`];
  if (url === undefined) throw new Error(`no fixture ${name}`);
  const b64 = url.slice(url.indexOf(",") + 1);
  return Uint8Array.from(atob(b64), (c) => c.codePointAt(0) ?? 0);
}

const RECORDED = import.meta.glob<Record<string, { hash: string; header: string }>>(
  "../../../../fixtures/ots/blocks.json",
  { eager: true, import: "default" },
);

/** Mainnet's recorded blocks, by height. */
export const BLOCKS = new Map<number, Block>(
  Object.entries(Object.values(RECORDED)[0] ?? {}).flatMap(([h, { hash, header }]) => {
    const block = readHeader(Number(h), hash, header);
    return block ? [[Number(h), block] as const] : [];
  }),
);

/** The digest `two-blocks.ots` is for. */
export const TWO_BLOCKS_DIGEST = "6fd9c1c4f096b77e6d4457bac1c7f51010d318db483f2868d3795843f098d378";
export const PENDING_DIGEST = "a70dfe69c5a0d62816781abb6e1777854718624a0d194231adb14c32ee5438a4";

export function varuint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    const b = v % 128;
    v = Math.floor(v / 128);
    out.push(v > 0 ? b | 0x80 : b);
  } while (v > 0);
  return out;
}

export function varbytes(b: Iterable<number> & { length: number }): number[] {
  const out = varuint(b.length);
  for (const x of b) out.push(x);
  return out;
}

export const OP: Record<
  "sha256" | "sha1" | "ripemd160" | "keccak256" | "reverse" | "hexlify",
  number[]
> & {
  append: (b: Iterable<number> & { length: number }) => number[];
  prepend: (b: Iterable<number> & { length: number }) => number[];
} = {
  sha256: [0x08],
  sha1: [0x02],
  ripemd160: [0x03],
  keccak256: [0x67],
  reverse: [0xf2],
  hexlify: [0xf3],
  append: (b: Iterable<number> & { length: number }) => [0xf0, ...varbytes(b)],
  prepend: (b: Iterable<number> & { length: number }) => [0xf1, ...varbytes(b)],
};

export const ATT = {
  bitcoin: (height: number) => [
    ...(fromHex("0588960d73d71901") ?? []),
    ...varbytes(varuint(height)),
  ],
  litecoin: (height: number) => [
    ...(fromHex("06869a0d73d71b45") ?? []),
    ...varbytes(varuint(height)),
  ],
  pending: (uri: string) => [
    ...(fromHex("83dfe30d2ef90c8e") ?? []),
    ...varbytes(varbytes(new TextEncoder().encode(uri))),
  ],
  unknown: (payload: number[]) => [1, 2, 3, 4, 5, 6, 7, 8, ...varbytes(payload)],
};

/** A stamp for the writer: attestations here, and branches of an operation and what follows. */
export interface Tree {
  att?: number[][];
  ops?: [number[], Tree][];
}

/** A stamp in the file's form: a fork byte before every item but the last. */
export function writeStamp(t: Tree): number[] {
  const items: number[][] = [];
  for (const a of t.att ?? []) items.push([0x00, ...a]);
  for (const [op, next] of t.ops ?? []) items.push([...op, ...writeStamp(next)]);
  const out: number[] = [];
  items.forEach((item, i) => {
    if (i < items.length - 1) out.push(0xff);
    out.push(...item);
  });
  return out;
}

/** A whole proof file: magic, version 1, SHA-256 of the file, the stamp. */
export function writeProof(digest: Uint8Array, t: Tree, version = 1, fileOp = 0x08): Uint8Array {
  return new Uint8Array([...MAGIC, ...varuint(version), fileOp, ...digest, ...writeStamp(t)]);
}

/** A path of operations with one attestation at its end. */
export function chain(ops: number[][], att: number[]): Tree {
  let t: Tree = { att: [att] };
  for (let i = ops.length - 1; i >= 0; i--) t = { ops: [[ops[i] ?? [], t]] };
  return t;
}
