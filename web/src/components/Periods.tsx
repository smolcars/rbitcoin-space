import { createEffect, For, onSettled, Show } from "solid-js";
import { Link } from "./Link";
import { scrollCue } from "./scrollCue";
import "./Periods.css";
import { dragScroll } from "./dragScroll";
import { owned } from "./owned";

/**
 * A chart's periods: one row of links, the current one pressed in, scrolling sideways on a phone
 * so the chart under it stays on the first screen (docs/DESIGN.md "The intervals are one row").
 * A view fitted to what is recorded has its own choice, "Recorded", and is the one marked current:
 * a period's name always means its whole width, never a narrower view.
 */
export function Periods(props: {
  choices: readonly { id: string; label: string; words: string }[];
  current: string;
  fitted: boolean;
  /** A period's address; the fitted view's without an id. */
  href: (id?: string) => string;
}) {
  let list: HTMLUListElement | undefined;
  // The chosen period in sight on a phone's one row, even when it is far along it: whenever the
  // choice changes, and when the browser brings the page back from its cache (Back, in Safari,
  // restored the row's old scroll with the chosen period out of sight).
  const reveal = () => {
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (list && current) list.scrollLeft = current.offsetLeft - list.clientWidth / 2;
  };
  createEffect(
    () => [props.current, props.fitted] as const,
    () => {
      requestAnimationFrame(reveal);
    },
  );
  onSettled(() => {
    reveal();
    window.addEventListener("pageshow", reveal);
    return () => window.removeEventListener("pageshow", reveal);
  });
  return (
    <nav class="periods" aria-label="Period">
      <ul
        ref={owned((el) => {
          list = el;
          scrollCue(el);
          dragScroll(el);
        })}
      >
        <Show when={props.fitted}>
          <li>
            <Link class="periods__item" href={props.href()} aria-current="page">
              Recorded
              <span class="visually-hidden">: since this server began recording</span>
            </Link>
          </li>
        </Show>
        <For each={props.choices}>
          {(p) => (
            <li>
              <Link
                class="periods__item"
                href={props.href(p.id)}
                aria-current={!props.fitted && p.id === props.current ? "page" : "false"}
              >
                {p.label}
                <span class="visually-hidden">: {p.words}</span>
              </Link>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );
}
