// Small pieces the VTXO page and its picture share: a transaction's state, the badges' icons.
import { Match, Show, Switch } from "solid-js";
import { Link } from "../../../components/Link";
import { groupDigits } from "../../../lib/format";
import { paths } from "../../../lib/network";
import type { Badge, OnChain } from "./vtxo";

/** In the mempool or confirmed on our node: it has a transaction page. */
export const onChainNow = (s: OnChain): boolean => s !== null && s.state !== "off";

/** Where a transaction is: confirmed (with its block), in the mempool, or still off chain. */
export function StateView(props: { state: OnChain; swept: boolean }) {
  const height = () => (props.state?.state === "confirmed" ? props.state.height : undefined);
  const word = () => {
    const state = props.state?.state;
    if (state === "mempool") return "In mempool";
    if (state === "off") return props.swept ? "Expired" : "Off chain";
    return undefined;
  };
  const icon = (): IconName => {
    if (props.state?.state === "mempool") return "dashed";
    return props.swept ? "cross" : "ring";
  };
  return (
    <Show
      when={height() === undefined}
      fallback={
        <span class="arkade-state arkade-state--confirmed">
          <Icon name="check" />
          Confirmed{" "}
          <Link class="num tap" href={paths.block(height() ?? 0)}>
            {groupDigits(height() ?? 0)}
          </Link>
        </span>
      }
    >
      <Show when={word() !== undefined} fallback={<span class="muted">–</span>}>
        <span
          class={["arkade-state", { "arkade-state--mempool": props.state?.state === "mempool" }]}
        >
          <Icon name={icon()} />
          {word()}
        </span>
      </Show>
    </Show>
  );
}

export function BadgeView(props: { badge: Badge }) {
  return (
    <span
      class={[
        "arkade-badge",
        `arkade-badge--${props.badge.tone}`,
        { "arkade-badge--provisional": props.badge.icon === "dashed" },
      ]}
    >
      <Icon name={props.badge.icon} />
      {props.badge.word}
    </span>
  );
}

type IconName = Badge["icon"] | "ring";

export function Icon(props: { name: IconName }) {
  return (
    <svg class="arkade-icon" viewBox="0 0 16 16" aria-hidden="true">
      <Switch>
        <Match when={props.name === "check"}>
          <path d="M3.5 8.5l3 3 6-7" />
        </Match>
        <Match when={props.name === "cross"}>
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </Match>
        <Match when={props.name === "arrow"}>
          <path d="M3 8h9M9 4.5L12.5 8 9 11.5" />
        </Match>
        <Match when={props.name === "up"}>
          <path d="M8 13V3.5M4.5 7L8 3.5 11.5 7" />
        </Match>
        <Match when={props.name === "dashed"}>
          <circle cx="8" cy="8" r="5" stroke-dasharray="2.4 1.8" />
        </Match>
        <Match when={props.name === "clock"}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.2l2 1.3" />
        </Match>
        <Match when={props.name === "ring"}>
          <circle cx="8" cy="8" r="4" />
        </Match>
      </Switch>
    </svg>
  );
}
