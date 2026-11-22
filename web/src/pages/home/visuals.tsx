// The home mempool panel's two pictures: the next projected block's map and the incoming rate. One
// lazy file, loaded only once the panel comes near the view, so a phone that never scrolls to it
// pays for neither the code nor the next block's transactions (docs/FRONTEND.md "Chunks").
import { createSignal, lazy, Loading as Pending, onCleanup, Show, untrack } from "solid-js";
import { formatSi } from "../../components/chart/scale";
import type { GridState } from "../../components/txgrid/TxGrid";
import { fetchApp } from "../../lib/api";
import { groupDigits } from "../../lib/format";
import { useLiveStatus, useTopic } from "../../lib/live";
import type { Network } from "../../lib/network";
import { BlockTxs, type ProjectedTx, projectedTxsTopic } from "../../lib/projected-txs";
import { flowSentence, type History, isHistory, pointTime, rateText } from "../mempool/history";
import { incoming } from "./incoming";

const TxGrid = lazy(() => import("../../components/txgrid/TxGrid"));
const Chart = lazy(() => import("../../components/chart/Chart"));

/** A block's vB: the frame stands for the weight limit, as on the block pages. */
const BLOCK_VSIZE = 1_000_000;
/** A new history minute lands about a second after each minute turns; ask just after. */
const REFRESH_OFFSET_MS = 3000;
/** Up to this many missing minutes are drawn across, as on the history page. */
const BRIDGE_STEPS = 5;

/**
 * The next projected block as a packed map, from `projected-txs:0`, read-only: no Highlight here
 * (docs/DESIGN.md "The goggles"). A square's tooltip and click are the grid's own.
 */
export function NextBlockMap() {
  const model = new BlockTxs();
  const [txs, setTxs] = createSignal<ProjectedTx[]>();
  const [off, setOff] = createSignal(false);
  const [outdated, setOutdated] = createSignal(false);
  const [grid, setGrid] = createSignal<GridState>();
  const status = useLiveStatus();
  const restart = useTopic(projectedTxsTopic(0), {
    message(m) {
      if (m.kind === "off") {
        setOff(true);
        return;
      }
      setOff(false);
      const r = model.apply(m);
      if (r.result === "lost") restart();
      else if (r.result === "version") setOutdated(true);
      else if (r.result === "changed") setTxs([...model.txs.values()]);
    },
    resync: () => model.expectSnapshot(),
  });
  const note = () =>
    off()
      ? "This server does not follow this network's mempool."
      : outdated()
        ? "Reload the page to see the map."
        : grid() === "unsupported"
          ? "The map needs WebGL2."
          : grid() === "lost"
            ? "The map is back when the browser restores its drawing."
            : txs()?.length === 0
              ? "Nothing is waiting: the next block would hold only its coinbase."
              : grid() === "drawn"
                ? undefined
                : // Its data comes only over the live connection: say so rather than stay blank.
                  status() === "live" || status() === "connecting"
                  ? "Loading the next block…"
                  : "The map shows while the page is live.";
  const label = () =>
    `Map of the next block's ${groupDigits(txs()?.length ?? 0)} projected transactions, the dearest at the top left`;
  return (
    <>
      {/* Kept once drawn, even when the block empties, so what leaves fades where it stood. */}
      <Show when={txs() && !off() && grid() !== "unsupported"}>
        <div class="home-next__grid">
          <Pending>
            <TxGrid
              txs={txs() ?? []}
              capacity={BLOCK_VSIZE}
              label={label()}
              txid={(tx) => Promise.resolve(String(tx.id))}
              onState={setGrid}
            />
          </Pending>
        </div>
      </Show>
      <Show when={note()}>{(text) => <p class="home-next__note">{text()}</p>}</Show>
    </>
  );
}

/** What entered the mempool over the last two hours, in vB a second, asked again each minute. */
export function IncomingChart(props: { network: Network; height: number }) {
  const [history, setHistory] = createSignal<History>();
  const [failed, setFailed] = createSignal(false);
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = false;
  const load = () => {
    controller?.abort();
    const c = new AbortController();
    controller = c;
    const fresh = asked;
    asked = true;
    fetchApp<unknown>(props.network, "/mempool/history/2h", {
      signal: c.signal,
      cached: !fresh,
    }).then(
      (v) => {
        if (c.signal.aborted) return;
        // A reply that cannot be read counts as a failure: the last good picture stays.
        if (isHistory(v)) setHistory(v);
        setFailed(!isHistory(v));
      },
      () => {
        // The last good picture stays; with none, the cell says so.
        if (!c.signal.aborted) setFailed(true);
      },
    );
  };
  const schedule = () => {
    timer = setTimeout(
      () => {
        load();
        schedule();
      },
      60_000 - (Date.now() % 60_000) + REFRESH_OFFSET_MS,
    );
  };
  untrack(load);
  schedule();
  onCleanup(() => {
    controller?.abort();
    clearTimeout(timer);
  });
  const summary = () => {
    const h = history();
    return (h && flowSentence(h, "the last 2 hours")) ?? "No data.";
  };
  const series = () => {
    const h = history();
    return h ? incoming(h) : undefined;
  };
  return (
    <Show
      when={(series()?.x.length ?? 0) > 0 ? series() : undefined}
      fallback={
        <p class="home-flow__note">
          {failed() && !history()
            ? "The incoming rate could not be loaded."
            : history()
              ? "Nothing recorded in the last two hours yet."
              : ""}
        </p>
      }
    >
      {(s) => (
        <Pending>
          <Chart
            label="Transactions arriving in the mempool, vB a second, the last 2 hours"
            x={s().x}
            domain={s().domain}
            gap={(history()?.step ?? 60) * (BRIDGE_STEPS + 1)}
            height={props.height}
            left={{ format: (v) => `${formatSi(v, "vB")}/s`, zero: true }}
            series={[
              {
                name: "Arriving",
                values: s().values,
                draw: "line",
                format: rateText,
                rawUnit: "vB/s",
              },
            ]}
            time={pointTime(60)}
            summary={summary()}
          />
        </Pending>
      )}
    </Show>
  );
}
