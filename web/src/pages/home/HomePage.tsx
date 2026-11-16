import { createEffect, lazy, Loading as Pending, Show } from "solid-js";
import { ApiError } from "../../lib/api";
import { useLiveStatus } from "../../lib/live";
import type { Network } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { BlockStrip } from "./BlockStrip";
import { FeePanel } from "./FeePanel";
import { createBlockFeed } from "./feeds";
import { createFees } from "./fees";
import { createLiveMempool } from "./live-mempool";
import { MempoolPanel } from "./MempoolPanel";
import { RecentTxs } from "./RecentTxs";
import { DifficultyPanel } from "./DifficultyPanel";
import "./HomePage.css";

// Beside the latest transactions on a wide screen and last on a phone, and its list waits for the
// live topic anyway: its code comes after the page's, so a cold home page still needs ten files
// (docs/FRONTEND.md).
const RecentReplacements = lazy(() => import("../mempool/RecentReplacements"));

/** A failure that means the node, not the request, is the problem. */
// The server's word that its node is not answering: a 5xx. A request that got no answer at all
// (status 0) is the reader's own connection, as when a phone wakes a tab it had frozen, and the
// socket's state says that already.
const nodeSilent = (e: unknown) => e instanceof ApiError && e.status >= 500;

export default function HomePage() {
  usePageTitle(() => "Blocks and mempool");
  const network = useNetwork();
  // Everything on the page belongs to one network: switching networks starts it afresh.
  return (
    <Show when={network()} keyed>
      {(n) => <Home network={n} />}
    </Show>
  );
}

function Home(props: { network: Network }) {
  const status = useLiveStatus();
  const blocks = createBlockFeed(props.network, status);
  const live = createLiveMempool(props.network, status);
  const fees = createFees(props.network, status);

  // A new tip changes the mempool when it is polled: ask at once rather than at the next tick.
  // Only on a change of tip, not when the first list arrives.
  createEffect(
    () => blocks.data()?.[0]?.id,
    (tip, before) => {
      if (before === undefined || tip === undefined) return;
      if (live.polling.mempool()) live.mempool.refresh();
      if (live.polling.recent()) live.recent.refresh();
    },
  );

  return (
    <div class="home">
      <BlockStrip
        blocks={blocks.data}
        error={blocks.error}
        retry={blocks.refresh}
        status={status}
        stale={() =>
          live.stale() || [blocks, live.mempool, live.recent].some((f) => nodeSilent(f.error()))
        }
        projection={live.projection}
        network={props.network}
      />
      <div class="home-grid wrap">
        <FeePanel answer={fees} />
        <MempoolPanel feed={live.mempool} network={props.network} />
        <RecentTxs feed={live.recent} />
        <DifficultyPanel network={props.network} tip={() => blocks.data()?.[0]?.id} />
        <Pending>
          <RecentReplacements network={props.network} class="home-rbf" />
        </Pending>
      </div>
    </div>
  );
}
