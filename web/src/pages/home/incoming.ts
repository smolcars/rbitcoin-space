// The home page's incoming rate: what entered the mempool, in vB a second, from the last two hours
// of the server's history (docs/FRONTEND.md "Mempool history"). Pure.
import { dataFrom, type History } from "../mempool/history";

export interface Incoming {
  /** Each point's time, unix seconds, oldest first. */
  x: number[];
  /** What arrived in that minute, vB a second. */
  values: number[];
  /** The time drawn: the period, or from the first record when recording began inside it. */
  domain: [number, number];
}

/**
 * The chart's series. A server that began recording inside the period draws from its first
 * record, so a young history fills the chart instead of hatching most of it.
 */
export function incoming(h: History): Incoming {
  return {
    x: h.points.map((p) => p.time),
    values: h.points.map((p) => p.in_vsize / 60),
    domain: [dataFrom(h) ?? h.from, h.to],
  };
}
