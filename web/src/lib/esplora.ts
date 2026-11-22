// Shapes of the Esplora API as rbitcoin serves it (docs/esplora-openapi.yaml at commit e0b2c68
// in rbitcoin). Hand-written: only what pages use. Amounts are integer sats, times unix seconds.

/** 64 hex characters, display order. */
export type Hash = string;

/** `/blocks`, `/blocks/:start_height`, `/block/:hash`. */
export interface Block {
  id: Hash;
  height: number;
  version: number;
  timestamp: number;
  tx_count: number;
  /** BIP144 total size, bytes. */
  size: number;
  /** BIP141 weight units. */
  weight: number;
  merkle_root: Hash;
  previousblockhash: Hash | null;
  mediantime: number;
  nonce: number;
  /** Compact target as an integer, not Core's hex string. */
  bits: number;
  difficulty: number;
}

/** `/block/:hash/status`. */
export interface BlockStatus {
  in_best_chain: boolean;
  height: number | null;
  next_best: Hash | null;
}

export interface TxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: Hash;
  block_time?: number;
}

export type ScriptType =
  | "p2pkh"
  | "p2sh"
  | "p2pk"
  | "v0_p2wpkh"
  | "v0_p2wsh"
  | "v1_p2tr"
  | "op_return"
  | "multisig"
  | "unknown";

export interface Vout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: ScriptType;
  scriptpubkey_address?: string;
  /** sats */
  value: number;
}

export interface Vin {
  txid: Hash;
  vout: number;
  is_coinbase: boolean;
  sequence?: number;
  scriptsig?: string;
  scriptsig_asm?: string;
  witness?: string[];
  inner_redeemscript_asm?: string;
  inner_witnessscript_asm?: string;
  prevout?: Vout | null;
}

/** `/tx/:txid`, and the items of block and address transaction lists. */
export interface Transaction {
  txid: Hash;
  version: number;
  locktime: number;
  size?: number;
  weight?: number;
  sigops?: number;
  /** sats */
  fee?: number;
  /** Absent on some pruned transactions; when present, every input is listed. */
  vin?: Vin[];
  vout: Vout[];
  status: TxStatus;
  /**
   * True below rbitcoin's prune point: the inputs' scripts, witnesses and sequences are gone,
   * `vin` is whole or absent (never some of the inputs), and `sigops` is missing.
   */
  pruned?: boolean;
}

/** `/tx/:txid/outspend/:vout` and the items of `/tx/:txid/outspends`. */
export interface Outspend {
  spent: boolean;
  txid?: Hash;
  vin?: number;
  status?: TxStatus;
}

export interface Utxo {
  txid: Hash;
  vout: number;
  value: number;
  status: TxStatus;
}

export interface AddressStatsPart {
  tx_count: number;
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
}

/** `/address/:address`. Large addresses answer 503 instead (node cap); show history anyway. */
export interface AddressStats {
  address?: string;
  scripthash?: Hash;
  chain_stats: AddressStatsPart;
  mempool_stats: AddressStatsPart;
}

/** Items of `/address/:address/txs/summary`, newest first. */
export interface TxSummary {
  txid: Hash;
  /** Net sats for the address in this transaction (funded − spent). */
  value: number;
  height: number;
  /** Confirming header time, 0 if unknown. */
  time: number;
  tx_position?: number;
}

/** `/mempool`. `fee_histogram` is [fee rate in sat/vB, vsize] pairs, dearest first. */
export interface MempoolSummary {
  count: number;
  vsize: number;
  total_fee: number;
  fee_histogram: [number, number][];
}

/** Items of `/mempool/recent`, newest first. */
export interface RecentTx {
  txid: Hash;
  fee: number;
  vsize: number;
  /** Total output value, sats. */
  value: number;
}

/** `/fee-estimates`: confirmation target in blocks → sat/vB. Targets without an estimate are left out. */
export type FeeEstimates = Record<string, number>;
