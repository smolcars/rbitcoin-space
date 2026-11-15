// Stand-ins for tests: a WebSocket that lets the test play the server, and made-up blocks.
import { flush } from "solid-js";
import type { Block } from "./esplora";
import type { SocketLike } from "./live";

export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  static last(): FakeSocket {
    const s = FakeSocket.all.at(-1);
    if (!s) throw new Error("no socket was opened");
    return s;
  }

  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  binaryType: BinaryType = "blob";
  /** Open (1) unless a test sets it to connecting (0) and later calls `open()`. */
  readyState: SocketLike["readyState"] = 1;
  readonly sent: unknown[] = [];
  closedWith: number | undefined | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closedWith = code;
  }

  /** The handshake completes. */
  open(): void {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
    flush();
  }

  /** The server sends a text frame (an object is sent as JSON) or a binary one. */
  receive(data: object | string | ArrayBuffer): void {
    const payload =
      typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data);
    this.onmessage?.call(this as unknown as WebSocket, { data: payload } as MessageEvent);
    // Each message is a task of its own in a browser: its update is applied before the next.
    flush();
  }
  hello(extra: object = {}): void {
    this.receive({ type: "hello", v: 1, network: "regtest", tip: null, ...extra });
  }
  /** The connection closes, from either side. */
  drop(code = 1006): void {
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
    flush();
  }
}

/** A block at `height` on branch `branch`, its parent the block below on the same branch. */
export function fakeBlock(height: number, branch = "a", parentBranch = branch): Block {
  const id = (h: number, b: string) => `${b}${h.toString(16).padStart(63, "0")}`;
  return {
    id: id(height, branch),
    height,
    previousblockhash: height === 0 ? null : id(height - 1, parentBranch),
    timestamp: 1_800_000_000 + height * 600,
    tx_count: 1,
    size: 250,
    weight: 1000,
    version: 1,
    merkle_root: "0".repeat(64),
    mediantime: 0,
    nonce: 0,
    bits: 0,
    difficulty: 1,
  };
}

/** A record for a `projected-txs:N` frame: rate in sat per 1,000 vB, as on the wire. */
export interface FakeRecord {
  txid: string;
  rate: number;
  vsize: number;
  fee: number;
  /** The transaction's flags; 0 when left out. */
  flags?: bigint;
}

function writeRecord(view: DataView, bytes: Uint8Array, at: number, r: FakeRecord): void {
  writeTxid(bytes, at, r.txid);
  view.setUint32(at + 32, r.rate, true);
  view.setUint32(at + 36, r.vsize, true);
  view.setBigUint64(at + 40, BigInt(r.fee), true);
  view.setBigUint64(at + 48, r.flags ?? 0n, true);
}

function writeTxid(bytes: Uint8Array, at: number, txid: string): void {
  for (let i = 0; i < 32; i++) bytes[at + i] = Number.parseInt(txid.slice(i * 2, i * 2 + 2), 16);
}

/** A snapshot frame (kind 1) as the server sends it (docs/WS.md "Binary frames"). */
export function snapshotFrame(
  block: number,
  seq: number,
  records: readonly FakeRecord[],
): ArrayBuffer {
  const buf = new ArrayBuffer(16 + 56 * records.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set([1, 2, block, 0]);
  view.setUint32(4, records.length, true);
  view.setBigUint64(8, BigInt(seq), true);
  for (const [i, r] of records.entries()) writeRecord(view, bytes, 16 + i * 56, r);
  return buf;
}

/** A delta frame (kind 2): the txids removed, then the records set. */
export function deltaFrame(
  block: number,
  seq: number,
  prev: number,
  removed: readonly string[],
  set: readonly FakeRecord[],
): ArrayBuffer {
  const buf = new ArrayBuffer(32 + 32 * removed.length + 56 * set.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set([2, 2, block, 0]);
  view.setUint32(4, removed.length, true);
  view.setBigUint64(8, BigInt(seq), true);
  view.setBigUint64(16, BigInt(prev), true);
  view.setUint32(24, set.length, true);
  for (const [i, txid] of removed.entries()) writeTxid(bytes, 32 + i * 32, txid);
  const at = 32 + 32 * removed.length;
  for (const [i, r] of set.entries()) writeRecord(view, bytes, at + i * 56, r);
  return buf;
}

/** A txid made from a number, for tests. */
export const fakeTxid = (n: number): string => n.toString(16).padStart(64, "0");
