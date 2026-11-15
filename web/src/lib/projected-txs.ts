// The `projected-txs:N` topics (docs/WS.md "Binary frames"): one projected block's transactions,
// a snapshot and then deltas. Decoding is strict and never throws: a server's bytes are still input.
import type { GridTx } from "../components/txgrid/layout";
import type { Topic } from "./live";

/** Blocks with a transactions topic: 0 (the next) to 6. The last projected block has none. */
export const PROJECTED_TXS_TOPICS = 7;

/** The frame format version this client reads. */
export const FRAME_VERSION = 2;
const KIND_SNAPSHOT = 1;
const KIND_DELTA = 2;
const SNAPSHOT_HEADER = 16;
const DELTA_HEADER = 32;
// txid 32, rate 4, vsize 4, fee 8, flags 8: the flags are not read yet.
const RECORD = 56;
const TXID = 32;

/** One transaction, as the grid draws it: `rate` is the effective rate in sat/vB. */
export interface ProjectedTx extends GridTx {
  id: string;
  rate: number;
}

export type Frame =
  | { kind: "snapshot"; block: number; seq: bigint; txs: ProjectedTx[] }
  | {
      kind: "delta";
      block: number;
      seq: bigint;
      prev: bigint;
      removed: string[];
      set: ProjectedTx[];
    }
  /** A snapshot or delta in a format version this client cannot read: the server is newer. */
  | { kind: "version"; block: number }
  /** Cut short, overlong, or with nonzero padding. The frame's data is lost. */
  | { kind: "malformed"; block: number }
  /** A kind of frame this client does not know, or too short to say whose it is: ignored. */
  | { kind: "unknown" };

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function hex(bytes: Uint8Array, at: number): string {
  let s = "";
  for (let i = at; i < at + TXID; i++) s += HEX[bytes[i] ?? 0];
  return s;
}

/** Records from `at`; undefined when a fee is beyond what a number holds exactly. */
function records(view: DataView, bytes: Uint8Array, at: number, count: number) {
  const txs: ProjectedTx[] = [];
  for (let i = 0; i < count; i++) {
    const o = at + i * RECORD;
    const fee = view.getBigUint64(o + 40, true);
    if (fee > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    txs.push({
      id: hex(bytes, o),
      rate: view.getUint32(o + TXID, true) / 1000,
      vsize: view.getUint32(o + 36, true),
      fee: Number(fee),
    });
  }
  return txs;
}

/** Reads one binary frame. Every length is checked against the counts before anything is read. */
export function decodeFrame(buffer: ArrayBuffer): Frame {
  const bytes = new Uint8Array(buffer);
  const kind = bytes[0];
  if ((kind !== KIND_SNAPSHOT && kind !== KIND_DELTA) || bytes.length < 3)
    return { kind: "unknown" };
  const block = bytes[2] ?? 0;
  if (bytes[1] !== FRAME_VERSION) return { kind: "version", block };
  const malformed = { kind: "malformed", block } as const;
  const view = new DataView(buffer);
  if (kind === KIND_SNAPSHOT) {
    if (bytes.length < SNAPSHOT_HEADER || bytes[3] !== 0) return malformed;
    const count = view.getUint32(4, true);
    if (bytes.length !== SNAPSHOT_HEADER + count * RECORD) return malformed;
    const txs = records(view, bytes, SNAPSHOT_HEADER, count);
    return txs ? { kind: "snapshot", block, seq: view.getBigUint64(8, true), txs } : malformed;
  }
  if (bytes.length < DELTA_HEADER || bytes[3] !== 0 || view.getUint32(28, true) !== 0) {
    return malformed;
  }
  const removedCount = view.getUint32(4, true);
  const setCount = view.getUint32(24, true);
  if (bytes.length !== DELTA_HEADER + removedCount * TXID + setCount * RECORD) return malformed;
  const removed: string[] = [];
  for (let i = 0; i < removedCount; i++) removed.push(hex(bytes, DELTA_HEADER + i * TXID));
  const set = records(view, bytes, DELTA_HEADER + removedCount * TXID, setCount);
  if (!set) return malformed;
  return {
    kind: "delta",
    block,
    seq: view.getBigUint64(8, true),
    prev: view.getBigUint64(16, true),
    removed,
    set,
  };
}

/** What a frame did to the model. */
export type Applied =
  /** The block changed: these txids came in and went out (a changed record is neither). */
  | { result: "changed"; added: string[]; removed: string[]; snapshot: boolean }
  /** The place is lost: unsubscribe and subscribe again (`useTopic`'s restart). */
  | { result: "lost" }
  /** Ignored: a delta while waiting for the snapshot a restart asked for, or one that changes nothing. */
  | { result: "ignored" }
  /** The server sends a format this page cannot read. */
  | { result: "version" };

/**
 * One projected block's transactions, kept current from its topic's frames. The map holds the
 * same object for a transaction until its record changes, as the grid wants.
 */
export class BlockTxs {
  readonly txs = new Map<string, ProjectedTx>();
  /** The `seq` of the last frame applied; undefined until a snapshot arrives. */
  seq: bigint | undefined;
  /** A restart was asked for and its snapshot has not come: deltas meanwhile are the old stream's. */
  private restarting = false;

  apply(frame: Frame): Applied {
    if (frame.kind === "snapshot") return this.snapshot(frame.seq, frame.txs);
    if (frame.kind === "delta") return this.delta(frame.seq, frame.prev, frame.removed, frame.set);
    if (frame.kind === "malformed") return this.lose();
    return { result: frame.kind === "version" ? "version" : "ignored" };
  }

  /** The socket reconnected and subscribed afresh: its first frame is a snapshot. */
  expectSnapshot(): void {
    this.seq = undefined;
    this.restarting = true;
  }

  private lose(): Applied {
    this.seq = undefined;
    if (this.restarting) return { result: "ignored" };
    this.restarting = true;
    return { result: "lost" };
  }

  private snapshot(seq: bigint, txs: readonly ProjectedTx[]): Applied {
    const next = new Map<string, ProjectedTx>();
    const added: string[] = [];
    for (const tx of txs) {
      const old = this.txs.get(tx.id);
      if (!old) added.push(tx.id);
      next.set(tx.id, old && same(old, tx) ? old : tx);
    }
    const removed = [...this.txs.keys()].filter((id) => !next.has(id));
    this.txs.clear();
    for (const [id, tx] of next) this.txs.set(id, tx);
    this.seq = seq;
    this.restarting = false;
    return { result: "changed", added, removed, snapshot: true };
  }

  private delta(
    seq: bigint,
    prev: bigint,
    removed: readonly string[],
    set: readonly ProjectedTx[],
  ): Applied {
    if (this.seq === undefined || prev !== this.seq) return this.lose();
    // Checked before anything changes, so a bad delta leaves the last good picture whole.
    if (removed.some((id) => !this.txs.has(id))) return this.lose();
    for (const id of removed) this.txs.delete(id);
    const added: string[] = [];
    for (const tx of set) {
      const old = this.txs.get(tx.id);
      if (!old) added.push(tx.id);
      if (!old || !same(old, tx)) this.txs.set(tx.id, tx);
    }
    this.seq = seq;
    const gone = removed.filter((id) => !this.txs.has(id));
    if (gone.length === 0 && added.length === 0 && set.length === 0) return { result: "ignored" };
    return { result: "changed", added, removed: gone, snapshot: false };
  }
}

const same = (a: ProjectedTx, b: ProjectedTx) =>
  a.rate === b.rate && a.vsize === b.vsize && a.fee === b.fee;

export type ProjectedTxsMessage = Frame | { kind: "off" };

/** `projected-txs:N`, for block `index` (0 to 6): its binary frames, and `off`. */
export function projectedTxsTopic(index: number): Topic<ProjectedTxsMessage> {
  return {
    name: `projected-txs:${index}`,
    parse: (m) => (m["type"] === "off" ? { kind: "off" } : undefined),
    binary(data) {
      const f = decodeFrame(data);
      return f.kind !== "unknown" && f.block === index ? f : undefined;
    },
  };
}
