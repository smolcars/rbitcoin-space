// Reads GET /app/block/:hash/txs?v=2, the fixed-width record of every transaction in a block
// (docs/FRONTEND.md "Block summaries"). Small and dependency-free, so a page can import it
// without loading the renderer.
import type { GridTx } from "./layout";

/** The record format this app reads. A different one means a newer server. */
export const TXS_VERSION = 2;
const HEADER = 8;
// The record's last eight bytes, the transaction's flags, are not read yet.
const RECORD = 28;

/** Why a reply could not be read. `version` asks for a reload; `malformed` is a broken reply. */
export class TxsFormatError extends Error {
  readonly kind: "version" | "malformed";
  constructor(kind: "version" | "malformed", message: string) {
    super(message);
    this.name = "TxsFormatError";
    this.kind = kind;
  }
}

/**
 * The transactions in block order, the coinbase first, each identified by its index in the block.
 * Throws {@link TxsFormatError} for another version, a truncated reply or trailing bytes.
 */
export function decodeTxs(buffer: ArrayBuffer): GridTx[] {
  if (buffer.byteLength < HEADER) {
    throw new TxsFormatError("malformed", "The transaction list was cut short.");
  }
  const view = new DataView(buffer);
  const version = view.getUint32(0, true);
  if (version !== TXS_VERSION) {
    throw new TxsFormatError("version", "The server is newer than this page. Reload to update.");
  }
  const count = view.getUint32(4, true);
  if (buffer.byteLength !== HEADER + count * RECORD) {
    throw new TxsFormatError("malformed", "The transaction list was cut short.");
  }
  const txs: GridTx[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER + i * RECORD;
    // Below 2^53 by the format's contract, so Number() is exact.
    txs.push({
      id: i,
      vsize: view.getUint32(o, true),
      fee: Number(view.getBigUint64(o + 4, true)),
      value: Number(view.getBigUint64(o + 12, true)),
      coinbase: i === 0,
    });
  }
  return txs;
}
