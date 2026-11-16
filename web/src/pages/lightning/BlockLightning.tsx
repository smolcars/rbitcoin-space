// The block page's one Lightning addition: the public channels a block opened and closed. Asks
// once its block has loaded, only on a network whose config lists Lightning, and loads the part
// that draws it only when there is something to draw. A block with none, a refusal or a graph
// still syncing shows nothing; the panel comes last on the page, so its arrival moves nothing.
import { lazy, Loading, Show } from "solid-js";
import { createRequest, fetchApp } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import { useNetwork } from "../../lib/page";

const BlockChannels = lazy(() => import("./BlockChannels"));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const some = (v: unknown, k: string): boolean => {
  const part = isObj(v) ? v[k] : undefined;
  return isObj(part) && typeof part["count"] === "number" && part["count"] > 0;
};

export function BlockLightning(props: { hash: string }) {
  const network = useNetwork();
  const [found] = createRequest(
    () => [network(), props.hash] as const,
    async ([n, hash], signal) => {
      const config = await loadConfig();
      if (config?.lightning.includes(n) !== true) return null;
      const v = await fetchApp<unknown>(n, `/lightning/block/${hash}`, { signal });
      return some(v, "opened") || some(v, "closed") ? v : null;
    },
  );
  return (
    <Show when={found.state === "ready" && found.latest}>
      {(v) => (
        <Loading>
          <BlockChannels found={v()} />
        </Loading>
      )}
    </Show>
  );
}
