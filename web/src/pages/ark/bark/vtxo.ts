// A Bark VTXO as `/app/ark/bark/vtxo/<id>` answers (docs/ARK.md), checked field by field, and
// what the page reads from it. The server built it from a Bark server's answer, which it verified,
// but the keys and amounts are still chain data: shown as text, never as markup.

export type TxKind = "branch" | "leaf" | "transfer";
export type Signature = "valid" | "missing" | "unchecked";

export interface ExitTx {
  /** Null when it could not be rebuilt (a policy the server does not build). */
  txid: string | null;
  kind: TxKind;
  /** Bark's own word for it: cosigned, hash-locked cosigned, arkoor. */
  bark: string;
  output: number;
  /** What our output holds, in sats. */
  value: number;
  siblings: number[];
  fee: number;
  signature: Signature;
}

export interface BarkVtxo {
  id: string;
  version: number;
  amount: number;
  expiryHeight: number;
  exitDelta: number;
  serverPubkey: string;
  policy: { kind: string; userPubkey: string | null };
  anchor: { txid: string; vout: number; value: number; found: boolean };
  rebuilt: boolean;
  /** The anchor commits to the expiry (and server key); otherwise they are the Bark server's word. */
  expiryBound: boolean;
  signatures: Signature;
  txs: ExitTx[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEY = /^0[23][0-9a-f]{64}$/;
const isHex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isSig = (v: unknown): v is Signature => v === "valid" || v === "missing" || v === "unchecked";
const KINDS: ReadonlySet<unknown> = new Set(["branch", "leaf", "transfer"]);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseTx(v: unknown): ExitTx | null {
  if (!isRecord(v)) return null;
  const { txid, kind, bark, output, value, siblings, fee, signature } = v;
  if (txid !== null && !isHex64(txid)) return null;
  if (!KINDS.has(kind) || typeof bark !== "string" || bark.length > 40) return null;
  if (!isCount(output) || !isCount(value) || !isCount(fee) || !isSig(signature)) return null;
  if (!Array.isArray(siblings) || !siblings.every((n) => isCount(n))) return null;
  return {
    txid,
    kind: kind as TxKind,
    bark,
    output,
    value,
    siblings,
    fee,
    signature,
  };
}

/** The reply, or null when it is not one. */
export function parseVtxo(body: unknown): BarkVtxo | null {
  if (!isRecord(body)) return null;
  const b = body;
  const { policy, anchor, txs } = b;
  if (typeof b["id"] !== "string" || !isVtxoId(b["id"])) return null;
  if (!isCount(b["version"]) || !isCount(b["amount"]) || !isCount(b["expiry_height"])) return null;
  if (!isCount(b["exit_delta"]) || typeof b["server_pubkey"] !== "string") return null;
  if (!KEY.test(b["server_pubkey"])) return null;
  if (!isRecord(policy) || typeof policy["kind"] !== "string") return null;
  const user = policy["user_pubkey"];
  if (user !== undefined && (typeof user !== "string" || !KEY.test(user))) return null;
  if (!isRecord(anchor) || !isHex64(anchor["txid"]) || !isCount(anchor["vout"])) return null;
  if (!isCount(anchor["value"]) || typeof anchor["found"] !== "boolean") return null;
  if (typeof b["rebuilt"] !== "boolean" || typeof b["expiry_bound"] !== "boolean") return null;
  if (!isSig(b["signatures"]) || !Array.isArray(txs)) {
    return null;
  }
  const parsed = txs.map((t) => parseTx(t));
  if (parsed.some((t) => t === null)) return null;
  return {
    id: b["id"],
    version: b["version"],
    amount: b["amount"],
    expiryHeight: b["expiry_height"],
    exitDelta: b["exit_delta"],
    serverPubkey: b["server_pubkey"],
    policy: { kind: policy["kind"].slice(0, 40), userPubkey: user ?? null },
    anchor: {
      txid: anchor["txid"],
      vout: anchor["vout"],
      value: anchor["value"],
      found: anchor["found"],
    },
    rebuilt: b["rebuilt"],
    expiryBound: b["expiry_bound"],
    signatures: b["signatures"],
    txs: parsed as ExitTx[],
  };
}

/** `<64 hex digits>:<vout>`, as the server takes it. Upper-case hex is read as lower. */
export function isVtxoId(s: string): boolean {
  return /^[0-9a-fA-F]{64}:(0|[1-9][0-9]{0,9})$/.test(s) && Number(s.split(":")[1]) <= 0xffffffff;
}

/** The id as typed or pasted, cleaned of spaces around it and lower-cased, or null. */
export function readVtxoId(input: string): string | null {
  const s = input.trim();
  return isVtxoId(s) ? s.toLowerCase() : null;
}

/** Bark refreshes a VTXO well before it expires; under this many blocks it is due. */
export const EXPIRING_BLOCKS = 144 * 3;

export interface Counts {
  tree: number;
  transfers: number;
}

export function counts(v: BarkVtxo): Counts {
  const transfers = v.txs.filter((t) => t.kind === "transfer").length;
  return { tree: v.txs.length - transfers, transfers };
}

/** Where a transaction of the exit is: not sent, waiting in the mempool, or in a block. */
export type OnChain =
  | { state: "none" }
  | { state: "mempool" }
  | { state: "confirmed"; height: number };

/** The badges, in order: what the reader should know before anything else. */
export type Badge =
  | "signed"
  | "unsigned"
  | "unverified"
  | "unsettled"
  | "exiting"
  | "expiring"
  | "expired";

export function badges(v: BarkVtxo, tip: number | undefined, onChain: readonly OnChain[]): Badge[] {
  const out: Badge[] = [];
  if (!v.rebuilt || !v.anchor.found || !v.expiryBound) out.push("unverified");
  else if (v.signatures === "valid") out.push("signed");
  else out.push("unsigned");
  if (onChain.some((s) => s.state !== "none")) out.push("exiting");
  if (v.txs.some((t) => t.kind === "transfer")) out.push("unsettled");
  if (tip !== undefined) {
    const left = v.expiryHeight - tip;
    if (left <= 0) out.push("expired");
    else if (left <= EXPIRING_BLOCKS) out.push("expiring");
  }
  return out;
}

/** Blocks as a rough time: "≈ 1 day", "≈ 2 h". */
export function roughTime(blocks: number): string {
  const minutes = blocks * 10;
  if (minutes < 120) return `≈ ${minutes} min`;
  const hours = minutes / 60;
  if (hours < 24) return `≈ ${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  return `≈ ${days} ${days === 1 ? "day" : "days"}`;
}

/** How far the VTXO is through its life, 0 to 1, from the anchor's block to its expiry. */
export function lifeElapsed(anchorHeight: number | undefined, tip: number, expiry: number): number {
  if (anchorHeight === undefined || expiry <= anchorHeight) return tip >= expiry ? 1 : 0;
  return Math.min(1, Math.max(0, (tip - anchorHeight) / (expiry - anchorHeight)));
}
