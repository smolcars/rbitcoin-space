// A made-up Arkade VTXO for the tests, shaped like signet's real answers: a batch of four VTXOs in a
// two-level tree, and this VTXO a transfer from one of its leaves through a checkpoint.
import type { VtxoAnswer } from "./vtxo";

const id = (c: string) => c.repeat(64);

export const C = id("c");
export const R = id("1");
export const B1 = id("2");
export const B2 = id("3");
export const L1 = id("4");
export const L2 = id("5");
export const L3 = id("6");
export const L4 = id("7");
export const K = id("8");
export const A = id("a");

/** Now, for the tests: 15 Nov 2026. */
export const NOW = 1_794_700_800;
const DAY = 86_400;

/** Unspent, not settled yet, 22 days from expiry; only its commitment is on chain. */
export function answer(): VtxoAnswer {
  const expires = NOW + 22 * DAY;
  return {
    vtxo: {
      txid: A,
      vout: 0,
      amount: 150_000,
      script: "5120".concat("ab".repeat(32)),
      created_at: NOW - 2 * DAY,
      expires_at: expires,
      preconfirmed: true,
      swept: false,
      unrolled: false,
      spent: false,
      spent_by: null,
      settled_by: null,
      ark_txid: null,
      commitment_txids: [C],
      depth: 1,
    },
    server: { signer_pubkey: "02".concat("11".repeat(32)), exit_delay_secs: 172_544 },
    chain: [
      { txid: A, kind: "ark", expires_at: expires, spends: [K] },
      { txid: K, kind: "checkpoint", expires_at: expires, spends: [L1] },
      { txid: L1, kind: "tree", expires_at: expires, spends: [B1] },
      { txid: B1, kind: "tree", expires_at: expires, spends: [R] },
      { txid: R, kind: "tree", expires_at: expires, spends: [C] },
      { txid: C, kind: "commitment", expires_at: expires, spends: [] },
    ],
    chain_complete: true,
    batches: [
      {
        commitment: C,
        vout: 0,
        started_at: NOW - 8 * DAY - 40,
        ended_at: NOW - 8 * DAY,
        expires_at: expires,
        vtxos: 4,
        amount: 600_000,
        swept: false,
        tree: [
          { txid: R, children: [B1, B2] },
          { txid: B1, children: [L1, L2] },
          { txid: B2, children: [L3, L4] },
          { txid: L1, children: [] },
          { txid: L2, children: [] },
          { txid: L3, children: [] },
          { txid: L4, children: [] },
        ],
      },
    ],
    batches_omitted: 0,
    onchain: [
      { state: "off" },
      { state: "off" },
      { state: "off" },
      { state: "off" },
      { state: "off" },
      { state: "confirmed", height: 274_022 },
    ],
  };
}
