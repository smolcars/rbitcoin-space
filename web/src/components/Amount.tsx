import { Show } from "solid-js";
import { btcParts, formatBtc, formatBtcShort, formatSats, MISSING } from "../lib/format";
import "./Amount.css";

/**
 * An amount in BTC, exact: all eight decimals, grouped as sats read (`0.00 012 500`), the trailing
 * zeros dimmed; the title gives sats. An amount a reader acts on or reads for one thing (an
 * address's balance, a transaction's outputs, a block's reward) is always exact.
 * `short` prints a magnitude instead ({@link formatBtcShort}), the exact amount in its title: only
 * in an overview read at a glance (the home page's blocks, the mining page's totals, a list of
 * nodes). `approx` puts `~` before it (a projected block).
 * `wrap` lets an exact amount break before its unit, or after its point, in a field a full amount
 * can outgrow (a phone's flow card, a large balance); otherwise it never wraps.
 * `unit={false}` hides the unit from sight only (a table names it in its header): screen readers
 * still read it.
 * `signed` adds a `+` to positive amounts (address history): the sign carries the direction, not
 * a colour.
 */
export function Amount(props: {
  sats: number;
  unit?: boolean;
  signed?: boolean;
  short?: boolean;
  approx?: boolean;
  wrap?: boolean;
}) {
  return (
    <Show when={btcParts(props.sats)} fallback={<span class="amount">{MISSING}</span>}>
      {(p) => (
        <Show
          when={!props.short}
          fallback={
            <span
              class="amount num"
              title={`${formatBtc(props.sats)} BTC, ${formatSats(props.sats)} sats`}
            >
              {props.approx ? "~" : ""}
              {formatBtcShort(props.sats)}
              <span class={{ unit: true, "visually-hidden": props.unit === false }}> BTC</span>
            </span>
          }
        >
          <span
            class={["amount num", { "amount--wrap": props.wrap }]}
            // The characters it cannot break inside, for a field that sizes it to fit (a flow card).
            style={props.wrap ? { "--amount-whole": p().whole.length + 1 } : undefined}
            title={`${formatSats(props.sats)} sats`}
          >
            {props.approx ? "~" : ""}
            {props.signed && props.sats > 0 ? "+" : p().sign}
            {p().whole}.{/* Only where it may wrap: Chromium breaks at a <wbr> even in `nowrap`. */}
            <Show when={props.wrap}>
              <wbr />
            </Show>
            {p().significant}
            <span class="amount__zeros">{p().zeros}</span>
            <span class={{ unit: true, "visually-hidden": props.unit === false }}> BTC</span>
          </span>
        </Show>
      )}
    </Show>
  );
}

/** An amount in sats, grouped. */
export function Sats(props: { sats: number; unit?: boolean }) {
  return (
    <span class="amount num">
      {formatSats(props.sats)}
      <span class={{ unit: true, "visually-hidden": props.unit === false }}> sats</span>
    </span>
  );
}
