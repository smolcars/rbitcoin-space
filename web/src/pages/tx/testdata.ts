// Transactions recorded from mainnet's public API for the chain text tests (fixtures/tx-text).
import type { Outspend, Transaction } from "../../lib/esplora";

export interface Sample {
  tx: Transaction;
  outspends: Outspend[];
}

const SAMPLES = import.meta.glob<Sample>("../../../../fixtures/tx-text/*.json", {
  eager: true,
  import: "default",
});

/** A recorded sample by its file name: genesis, coinbase-pool, opreturn-short, inscription-text… */
export function sample(name: string): Sample {
  const s = SAMPLES[`../../../../fixtures/tx-text/${name}.json`];
  if (!s) throw new Error(`no sample ${name}`);
  return s;
}
