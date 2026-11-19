import { For, Show } from "solid-js";
import { hashGroups } from "../lib/format";
import type { JSX } from "@solidjs/web";
import { CopyButton } from "./CopyButton";
import { Link } from "./Link";
import "./Hash.css";

export interface HashProps {
  value: string;
  /** Network-free page path (from `paths`) to link to. */
  href?: string;
  /** History state the link's navigation carries, as JSON (the router's `state`); never the URL. */
  linkState?: string | undefined;
  /**
   * Characters kept at each end: 8 and 8 in lists, 7 and 5 for addresses in the flow diagram. Where
   * the room is narrower still, the head gives way to its ellipsis; the tail is always whole.
   */
  head?: number;
  tail?: number;
  /** Copy button; on by default. */
  copy?: boolean;
  /** What the copy button copies, for its label: "Copy transaction ID". */
  copyLabel?: string;
  /** The whole value, wrapping where it must, instead of a shortened one. */
  whole?: boolean;
  /**
   * As much as the room allows: the value cut in the middle only when its column is narrower than
   * it, always keeping the last eight characters. For a table's identifier column.
   */
  fit?: boolean;
}

/** A hash or address shortened in the middle, in the monospace cut. Full value in the title and the copy. */
export function Hash(props: HashProps) {
  const head = () => props.head ?? 8;
  const tail = () => props.tail ?? 8;
  const ends = () => !props.whole && !props.fit && props.value.length > head() + tail() + 1;
  const short = (): JSX.Element =>
    props.fit ? (
      <>
        <span class="hash__head">{props.value.slice(0, -8)}</span>
        <span class="hash__tail">{props.value.slice(-8)}</span>
      </>
    ) : ends() ? (
      <>
        <span class="hash__head">{props.value.slice(0, head())}…</span>
        <span class="hash__tail">{props.value.slice(-tail())}</span>
      </>
    ) : (
      props.value
    );
  return (
    <span
      class={[
        "hash",
        {
          "hash--whole": props.whole === true,
          "hash--fit": props.fit === true,
          "hash--ends": ends(),
        },
      ]}
    >
      <Show
        when={props.href}
        fallback={
          <span class="hash__text" title={props.value}>
            {short()}
          </span>
        }
      >
        {(href) => (
          <Link
            class="hash__text tap-line"
            href={href()}
            title={props.value}
            state={props.linkState}
          >
            {short()}
          </Link>
        )}
      </Show>
      <Show when={props.copy !== false}>
        <CopyButton value={props.value} {...(props.copyLabel ? { label: props.copyLabel } : {})} />
      </Show>
    </span>
  );
}

/** A hash shown whole as a page subject, in groups of eight, with a copy button. */
export function HashFull(props: { value: string; copyLabel?: string }) {
  return (
    <span class="hash hash--full">
      <span class="hash__text">
        <For each={hashGroups(props.value)}>{(g) => <span class="hash__group">{g}</span>}</For>
      </span>
      <CopyButton value={props.value} {...(props.copyLabel ? { label: props.copyLabel } : {})} />
    </span>
  );
}
