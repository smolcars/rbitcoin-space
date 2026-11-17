// MOCKUP, never merged: mainnet answers recorded once from rbitcoin.space (GET only), compacted:
// block series keep every point but only the fields drawn, as arrays.
import type { Coverage } from "../../lib/api";
import type { DifficultyAdjustment } from "../../lib/difficulty";
import type {
  Adjustment,
  Hashrates,
  Prediction,
  Ranked,
  Ranking,
  RewardStats,
} from "../mining/mining";
import common from "./data/common.json?raw";

export interface Answer<T> {
  value: T;
  coverage?: Coverage;
}

export type MockPool = Ranked & { avgMatchRate: number | null };

export interface PeriodSample {
  pools: Answer<Omit<Ranking, "pools"> & { pools: MockPool[] }>;
  reward: Answer<RewardStats>;
  hashrate: Answer<Hashrates>;
  /** Weekly pool shares, `[week, pool, share]`, from a month up. */
  weeks?: Answer<[number, string, number][]>;
  /** `[time, average fees in sats]`. */
  fees: Answer<[number, number][]>;
  /** `[time, average size in bytes, average weight]`. */
  sizes: Answer<[number, number, number][]>;
  /** `[time, p10, p25, p50, p75, p90]` in sat/vB. */
  rates: Answer<[number, number, number, number, number, number][]>;
  predictions: Answer<Prediction[]>;
}

export interface Summary {
  id: string;
  fee_rate: { median: number } | null;
  fee_bands: number[];
  miner: { name: string; slug: string } | null;
}

export interface CommonSample {
  /** When it was recorded, unix seconds: the mock's "now". */
  recordedAt: number;
  /** The latest 30 adjustments, newest first. */
  adjustments: Adjustment[];
  next: DifficultyAdjustment;
  blocks: { id: string; height: number; timestamp: number; tx_count: number; weight: number }[];
  summaries: Summary[];
}

export const COMMON = JSON.parse(common) as CommonSample;

/** The periods recorded: "All" is left out, its weekly pool shares alone are 1.4 MB. */
export const MOCK_PERIODS = ["24h", "1w", "1m", "1y"] as const;
export type MockPeriod = (typeof MOCK_PERIODS)[number];

const files: Record<MockPeriod, () => Promise<{ default: string }>> = {
  "24h": () => import("./data/24h.json?raw"),
  "1w": () => import("./data/1w.json?raw"),
  "1m": () => import("./data/1m.json?raw"),
  "1y": () => import("./data/1y.json?raw"),
};

export const loadPeriod = (p: MockPeriod): Promise<PeriodSample> =>
  files[p]().then((m) => JSON.parse(m.default) as PeriodSample);
