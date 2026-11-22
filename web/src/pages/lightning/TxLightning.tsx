// The transaction page's one addition: when a confirmed transaction funded or closed a Lightning
// channel, say so and link to it. Asks only on a network whose peer is synced, and loads the part
// that draws it only when there is something to draw, so an ordinary transaction costs two small
// requests after its page has shown, and a network without Lightning one per tab.
import { createRequest, fetchApp } from "../../lib/api";
import type { Network } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { lazy, Loading, Show } from "solid-js";

const TxChannels = lazy(() => import("./TxChannels"));

/** Networks whose server said Lightning is off: it stays off until the server restarts. */
const off = new Set<Network>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function TxLightning(props: { txid: string; confirmed: boolean }) {
  const network = useNetwork();
  const [found] = createRequest(
    () => props.confirmed && !off.has(network()) && ([network(), props.txid] as const),
    async ([n, txid], signal) => {
      const status = await fetchApp<unknown>(n, "/lightning/status", { signal, cached: true });
      const state = isObj(status) ? status["state"] : undefined;
      if (state === "off") off.add(n);
      if (state !== "synced") return null;
      const v = await fetchApp<unknown>(n, `/lightning/tx/${txid}`, { signal, cached: true });
      const some = (k: string) => isObj(v) && Array.isArray(v[k]) && v[k].length > 0;
      return some("opened") || some("closed") ? v : null;
    },
  );
  return (
    <Show when={found.state === "ready" && found.latest}>
      {(v) => (
        <Loading>
          <TxChannels found={v()} />
        </Loading>
      )}
    </Show>
  );
}
