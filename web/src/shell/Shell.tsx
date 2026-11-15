import { useLocation, useNavigate } from "@solidjs/router";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createSignal,
  Errored,
  Loading as Pending,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { Empty, ErrorState, Loading } from "../components/States";
import { createRequest } from "../lib/api";
import { CHUNK_ATTEMPTS, chunkDelay, isChunkError, reloadOnce, retryFiles } from "../lib/chunks";
import { fetchConfig, readConfig } from "../lib/config";
import { NETWORK_NAMES, type Network, onNetwork, stripNetwork } from "../lib/network";
import { useNetwork } from "../lib/page";
import { Footer } from "./Footer";
import { Header } from "./Header";
import "./Shell.css";

/** The frame around every page: band, header, main and footer. The router's root component. */
export function Shell(props: { children?: JSX.Element }) {
  const network = useNetwork();
  const location = useLocation();
  const navigate = useNavigate();
  const [config] = createRequest(() => true, readConfig);
  // Undefined until the server answers, so the switch keeps its full shape meanwhile.
  const networks = (): readonly Network[] | undefined => {
    if (config.loading) return undefined;
    const enabled = config()?.networks;
    return enabled && enabled.length > 0 ? enabled : [network()];
  };
  let main: HTMLElement | undefined;

  createEffect(network, (n) => {
    document.documentElement.dataset["network"] = n;
  });

  // A path on a network this server does not serve (mainnet at the root) moves to one it does.
  createEffect(
    () => {
      const enabled = config()?.networks;
      const first = enabled?.[0];
      return first && !enabled.includes(network())
        ? onNetwork(first, stripNetwork(location.pathname))
        : undefined;
    },
    (to) => {
      if (to !== undefined) navigate(to, { replace: true });
    },
  );

  // Each page gets its own automatic attempts at files that failed to download.
  createEffect(
    () => location.pathname,
    () => {
      chunkAttempts = 0;
      checkedAt = Number.NEGATIVE_INFINITY;
    },
  );

  // After a navigation, focus moves to the new page so screen readers start there.
  createEffect(
    () => location.pathname,
    () => main?.focus({ preventScroll: true }),
    { defer: true },
  );

  return (
    <>
      {/* rel="external" keeps the router out, so the browser moves focus to main itself. */}
      <a class="skip" href="#main" rel="external">
        Skip to content
      </a>
      <Show when={network() !== "mainnet"}>
        <div class="network-band" role="region" aria-label="Test network">
          <p class="network-band__text">
            {NETWORK_NAMES[network()]} is a test network. Coins here have no value.
          </p>
        </div>
      </Show>
      <Header networks={networks} ark={() => config()?.ark} />
      <main id="main" class="site-main" tabindex="-1" ref={main}>
        <Errored
          fallback={(error, reset) => {
            createEffect(() => location.pathname, reset, { defer: true });
            return (
              <div class="wrap">
                <PageFailure error={error()} reset={reset} version={config()?.version} />
              </div>
            );
          }}
        >
          <Pending
            fallback={
              <div class="wrap">
                <Loading />
              </div>
            }
          >
            {props.children}
          </Pending>
        </Errored>
      </main>
      <Footer version={() => config()?.version} />
    </>
  );
}

/** Automatic attempts made so far at the page's files; the reader's own "Try again" starts afresh. */
let chunkAttempts = 0;
/** When an attempt last rendered the page again after proving its scripts download now. */
let checkedAt = Number.NEGATIVE_INFINITY;
/** A chunk error this soon after that came from the browser's memory of the failure, not the network. */
const HELD_MS = 2000;

/**
 * A page that could not be shown. When its code or styles failed to download, they are asked for
 * again, waiting longer each time, while the page shows that it is loading; only then does it ask
 * the reader. If the server's version changed since this tab loaded, the files it needs were
 * replaced by a deploy, so it says so and offers a reload instead.
 */
function PageFailure(props: { error: unknown; reset: () => void; version: string | undefined }) {
  // The failure this fallback was made for: a new one makes a new fallback.
  const chunk = isChunkError(untrack(() => props.error));
  // The code failed again right after it was shown to download: the browser holds on to the
  // failure (WebKit does, for the life of the document), so only a reload gets past it.
  const reloading = chunk && Date.now() - checkedAt < HELD_MS && reloadOnce();
  const first = reloading || (chunk && chunkAttempts < CHUNK_ATTEMPTS) ? "waiting" : "failed";
  const [state, setState] = createSignal<"waiting" | "updated" | "failed">(first);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const updated = async () => {
    const now = (await fetchConfig())?.version;
    return props.version !== undefined && now !== undefined && now !== props.version;
  };
  const recover = async () => {
    while (chunkAttempts < CHUNK_ATTEMPTS) {
      const wait = chunkDelay(chunkAttempts++);
      // oxlint-disable-next-line no-await-in-loop -- each attempt waits longer than the last
      await new Promise((resolve) => {
        setTimeout(resolve, wait);
      });
      if (!alive) return;
      // oxlint-disable-next-line no-await-in-loop -- asked before each attempt, once the wait is over
      if (await updated()) {
        setState("updated");
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- the page is shown only once its styles are in
        const { scripts } = await retryFiles();
        // A page left meanwhile must not hand its evidence to the next one.
        if (!alive) return;
        if (scripts) checkedAt = Date.now();
        props.reset();
        return;
      } catch {
        // A file failed again: wait longer and try once more.
      }
    }
    if (alive) setState("failed");
  };
  if (first === "waiting" && !reloading) void recover();

  const tryAgain = async () => {
    chunkAttempts = CHUNK_ATTEMPTS;
    setState("waiting");
    if (chunk && (await updated())) {
      setState("updated");
      return;
    }
    // A render error can follow a stylesheet that failed too; either way everything is asked again.
    const files = await retryFiles().catch(() => undefined);
    if (!alive) return;
    if (files?.scripts) checkedAt = Date.now();
    if (files || !chunk) props.reset();
    else setState("failed");
  };

  return (
    <Show when={state() !== "waiting"} fallback={<Loading label="Loading this page" />}>
      <Show
        when={state() === "updated"}
        fallback={
          <ErrorState
            title="This page could not be shown"
            error={props.error}
            {...(chunk
              ? {
                  message:
                    "Part of it could not be downloaded. Check your connection and try again. If this keeps happening, reload the page.",
                }
              : {})}
            retry={() => void tryAgain()}
          />
        }
      >
        {/* Not a failure, so not an alert: the one thing to do is the accented button. */}
        <Empty title="This site has been updated">
          <p>
            This tab still runs the version from before, and the page you opened needs files the
            update replaced. Reload to use the new version.
          </p>
          <button class="btn btn--accent" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </Empty>
      </Show>
    </Show>
  );
}
