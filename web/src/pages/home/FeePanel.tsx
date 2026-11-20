import { createMemo, For, Show } from "solid-js";
import { Link } from "../../components/Link";
import { SectionHeader } from "../../components/SectionHeader";
import { formatFeeRateUp } from "../../lib/format";
import { paths } from "../../lib/network";
import { type FeeAnswer, type FeeGroup, groupLevels } from "./fees";

/**
 * Where an answer sits on a phone's two rows of two: one cell, a whole row, or both rows. A lone
 * answer beside a group of three takes its row too, so there are always exactly two rows. Wider,
 * the answers are one row of four, each as wide as the levels it stands for (`--span`).
 */
function placement(span: number, groups: readonly FeeGroup[]): "cell" | "row" | "all" {
  if (span === 4) return "all";
  return span > 1 || groups.some((g) => g.span === 3) ? "row" : "cell";
}

/**
 * "Fee to pay now": four plainly labelled rates, slowest first, each with what it promises, rounded
 * up so the figure is never less than the rate it stands for. Neighbours that print the same rate
 * read as one answer. The node's estimates, served while the server cannot make its own, say so;
 * no answer shows no number.
 */
export function FeePanel(props: { answer: () => FeeAnswer | null | undefined }) {
  const groups = createMemo(() => groupLevels(props.answer() ?? undefined, formatFeeRateUp));
  const note = () =>
    props.answer()?.source === "node"
      ? "The node's own estimates: this server has none of its own right now."
      : groups().length === 1 && groups()[0]?.rate !== undefined
        ? "Every wait pays the same: the next block has room at this rate."
        : undefined;
  return (
    <section class="home-fees" aria-labelledby="fees-title">
      <SectionHeader title="Fee to pay now" id="fees-title">
        {/* The evidence for these numbers, misses included. */}
        <Link href={paths.feeScore()}>Track record</Link>
      </SectionHeader>
      <Show
        when={props.answer() !== null}
        fallback={
          // Rather than show an old answer, the panel waits for a current one.
          <p class="home-fees__none">No recommendation right now.</p>
        }
      >
        <dl class="home-fees__list" aria-busy={props.answer() ? "false" : "true"}>
          <For each={groups()}>
            {(g) => (
              <div
                class={["home-fees__item", `home-fees__item--${placement(g.span, groups())}`]}
                style={{ "--span": String(g.span) }}
              >
                <dt>
                  <span class="home-fees__name">{g.name}</span>
                  <span class="home-fees__when">{g.when}</span>
                </dt>
                <dd class="home-fees__rate">
                  <Show when={g.rate} fallback={<span class="muted">–</span>}>
                    {(r) => (
                      <>
                        <span class="num">{formatFeeRateUp(r())}</span>
                        <span class="unit"> sat/vB</span>
                      </>
                    )}
                  </Show>
                </dd>
              </div>
            )}
          </For>
        </dl>
        {/* A line under the answers only when they need one: the node's estimates say so, and one
            answer for every wait (signet's usual) says why. */}
        <Show when={note()}>{(text) => <p class="home-fees__note">{text()}</p>}</Show>
      </Show>
    </section>
  );
}
