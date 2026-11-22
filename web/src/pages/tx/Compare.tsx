// What changed between two versions of a replaced transaction: their figures side by side, and
// their outputs matched by destination (lib/compare.ts). Scripts and addresses are chain data and
// are only ever set as text.
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount, Sats } from "../../components/Amount";
import { FeeRate } from "../../components/FeeRate";
import { Hash } from "../../components/Hash";
import { createRequest, fetchApp } from "../../lib/api";
import {
  type Comparison,
  inputChange,
  type KeptOutput,
  type Matched,
  matchOutputs,
  type OutputChange,
  parseComparison,
} from "../../lib/compare";
import { formatSize, groupDigits, MISSING } from "../../lib/format";
import { paths } from "../../lib/network";
import { useNetwork } from "../../lib/page";
import { classify } from "./script";
import "./Compare.css";

/** A version's name in the line: its place, and which is this page's. */
function versionName(i: number, txid: string, here: string): string {
  return `Version ${i + 1}${txid === here ? ", this page" : ""}`;
}

/**
 * The compare view for a line of versions, oldest first, showing `from` against `to` (indices into
 * `versions`). The pair is the caller's, so its other controls (the chain's buttons) and the
 * pickers here always show the same one: a pick calls `onPick`.
 */
export function Compare(props: {
  versions: string[];
  from: number;
  to: number;
  here: string;
  onPick: (from: number, to: number) => void;
}) {
  const network = useNetwork();
  const ids = () => {
    const a = props.versions[props.from];
    const b = props.versions[props.to];
    return a && b && a !== b ? `${a}/${b}` : false;
  };
  const [answer, { refetch }] = createRequest(ids, async (pair, signal) => {
    const [a, b] = pair.split("/");
    const r = parseComparison(
      await fetchApp<unknown>(network(), `/tx/${a}/compare/${b}`, { signal, cached: true }),
    );
    if (!r) throw new Error("unreadable comparison");
    return r;
  });
  const name = (txid: string) => versionName(props.versions.indexOf(txid), txid, props.here);
  return (
    <section class="tx-compare" id="tx-compare" aria-labelledby="tx-compare-title">
      <h3 class="tx-compare__title" id="tx-compare-title">
        What changed
      </h3>
      <Show when={props.versions.length > 2}>
        <div class="tx-compare__pick">
          <Pick
            label="From"
            value={props.from}
            versions={props.versions}
            here={props.here}
            onPick={(i) => props.onPick(i, props.to)}
          />
          <Pick
            label="To"
            value={props.to}
            versions={props.versions}
            here={props.here}
            onPick={(i) => props.onPick(props.from, i)}
          />
        </div>
      </Show>
      <Switch>
        <Match when={ids() === false}>
          <p class="tx-compare__note">Pick two different versions.</p>
        </Match>
        <Match when={answer.state === "errored"}>
          <p class="tx-compare__note">
            The server could not compare these versions.{" "}
            <button class="btn tx-compare__retry" type="button" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        </Match>
        <Match when={answer.latest} keyed>
          {(c) => <Answer c={c} name={name} busy={answer.loading} />}
        </Match>
        <Match when={true}>
          <p class="tx-compare__note" aria-busy="true">
            Comparing…
          </p>
        </Match>
      </Switch>
    </section>
  );
}

function Pick(props: {
  label: string;
  value: number;
  versions: string[];
  here: string;
  onPick: (i: number) => void;
}) {
  return (
    <label class="tx-compare__picker">
      <span>{props.label}</span>
      <select
        class="tx-compare__select"
        value={String(props.value)}
        onChange={(e) => props.onPick(Number(e.currentTarget.value))}
      >
        <For each={props.versions}>
          {(t, i) => (
            <option value={String(i())} selected={i() === props.value}>
              {versionName(i(), t, props.here)}, {t.slice(0, 8)}…
            </option>
          )}
        </For>
      </select>
    </label>
  );
}

/** A difference, signed, or nothing to say when either side is unknown. */
function diff(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : b - a;
}

function Answer(props: { c: Comparison; name: (txid: string) => string; busy: boolean }) {
  const a = () => props.c.a;
  const b = () => props.c.b;
  const matched = () => matchOutputs(a().outputs, b().outputs);
  const inputs = () => inputChange(a(), b(), props.c.sharedInputs);
  return (
    <div class={["tx-compare__answer", { "is-busy": props.busy }]}>
      <div class="tx-compare__scroll">
        <table class="tx-compare__figures">
          <caption class="visually-hidden">
            {props.name(a().txid)} against {props.name(b().txid)}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span class="visually-hidden">Figure</span>
              </th>
              <th scope="col">
                <span class="tx-compare__version">{props.name(a().txid)}</span>
                <Hash value={a().txid} href={paths.tx(a().txid)} copy={false} head={6} tail={4} />
              </th>
              <th scope="col">
                <span class="tx-compare__version">{props.name(b().txid)}</span>
                <Hash value={b().txid} href={paths.tx(b().txid)} copy={false} head={6} tail={4} />
              </th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            <Figure
              label="Fee"
              a={a().fee}
              b={b().fee}
              show={(v) => <Sats sats={v} />}
              change={(d) => <Signed sats={d} />}
            />
            <Figure
              label="Fee rate"
              a={a().rate}
              b={b().rate}
              show={(v) => <FeeRate rate={v} />}
              change={(d) => (
                <span class="num">
                  {d > 0 ? "+" : d < 0 ? "−" : "±"}
                  <FeeRate rate={Math.abs(d)} />
                </span>
              )}
            />
            <Figure
              label="Virtual size"
              a={a().vsize}
              b={b().vsize}
              show={(v) => <span class="num">{formatSize(v)}</span>}
              change={(d) => (
                <span class="num">
                  {d > 0 ? "+" : d < 0 ? "−" : "±"}
                  {formatSize(Math.abs(d))}
                </span>
              )}
            />
            <Figure
              label="Paid out"
              a={a().value}
              b={b().value}
              show={(v) => <Amount sats={v} />}
              change={(d) => <Signed sats={d} btc />}
            />
            <Figure
              label="Inputs"
              always
              a={a().inputs}
              b={b().inputs}
              show={(v) => <span class="num">{groupDigits(v)}</span>}
              change={() => (
                <Show when={inputs()} fallback={<span class="tx-compare__muted">{MISSING}</span>}>
                  {(n) => <InputsChange {...n()} />}
                </Show>
              )}
            />
          </tbody>
        </table>
      </div>
      <Show when={props.c.vsizeBasis === "weight"}>
        <p class="tx-compare__note">
          Sizes and rates here are weight over four for both versions: the node does not count
          signature operations for a version this server never held, so neither side does.
        </p>
      </Show>
      <h4 class="tx-compare__subtitle">Outputs, matched by where they pay</h4>
      <Outputs matched={matched()} name={props.name} a={a().txid} b={b().txid} />
    </div>
  );
}

/** A table row of one figure for both versions and its change. */
function Figure(props: {
  label: string;
  a: number | undefined;
  b: number | undefined;
  show: (v: number) => JSX.Element;
  change: (d: number) => JSX.Element;
  /** The change says more than the difference (inputs: the same count can be other inputs). */
  always?: boolean;
}) {
  const cell = (v: number | undefined) =>
    v === undefined ? <span class="tx-compare__muted">{MISSING}</span> : props.show(v);
  const d = () => diff(props.a, props.b);
  const change = (): JSX.Element => {
    const v = d();
    if (props.always === true) return props.change(v ?? 0);
    if (v === undefined) return <span class="tx-compare__muted">{MISSING}</span>;
    return v === 0 ? <span class="tx-compare__muted">Same</span> : props.change(v);
  };
  return (
    <tr>
      <th scope="row">{props.label}</th>
      <td>{cell(props.a)}</td>
      <td>{cell(props.b)}</td>
      <td class="tx-compare__change">{change()}</td>
    </tr>
  );
}

/** A signed amount: the sign carries the direction, never a colour (DESIGN.md). */
function Signed(props: { sats: number; btc?: boolean }) {
  return (
    <Show
      when={props.btc}
      fallback={
        <span class="num">
          {props.sats > 0 ? "+" : "−"}
          <Sats sats={Math.abs(props.sats)} />
        </span>
      }
    >
      <Amount sats={props.sats} signed />
    </Show>
  );
}

function InputsChange(props: { kept: number; dropped: number; added: number }) {
  const parts = () =>
    [
      props.kept > 0 ? `${groupDigits(props.kept)} kept` : "",
      props.dropped > 0 ? `${groupDigits(props.dropped)} dropped` : "",
      props.added > 0 ? `${groupDigits(props.added)} new` : "",
    ].filter(Boolean);
  return <span>{parts().join(", ") || "Same"}</span>;
}

const KIND: Record<OutputChange["kind"], { word: string; glyph: string }> = {
  kept: { word: "Same", glyph: "=" },
  changed: { word: "Changed", glyph: "≠" },
  added: { word: "Added", glyph: "+" },
  removed: { word: "Removed", glyph: "−" },
};

function Outputs(props: { matched: Matched; name: (t: string) => string; a: string; b: string }) {
  const who = (side: "a" | "b" | "both") =>
    side === "both" ? "either version" : props.name(side === "a" ? props.a : props.b);
  return (
    <Switch>
      <Match when={props.matched.state === "not_recorded" && props.matched} keyed>
        {(m) => (
          <p class="tx-compare__note">
            This server did not record the outputs of {who(m.side)}: it was replaced before the
            server kept outputs, the server never saw it waiting, or the node has forgotten it. The
            figures above still stand.
          </p>
        )}
      </Match>
      <Match when={props.matched.state === "too_many" && props.matched} keyed>
        {(m) => (
          <p class="tx-compare__note">
            {m.side === "both" ? "Both versions have" : `${who(m.side)} has`} too many outputs to
            compare ({m.counts.map((n) => (n === null ? MISSING : groupDigits(n))).join(" and ")}):
            the server keeps at most 32 for each version.
          </p>
        )}
      </Match>
      <Match when={props.matched.state === "matched" && props.matched} keyed>
        {(m) => (
          <ul
            class="tx-compare__outputs"
            aria-label="Where each version pays, matched: the newer one's order, then what it removed"
          >
            <For each={m.rows}>{(r) => <OutputRow row={r} />}</For>
          </ul>
        )}
      </Match>
    </Switch>
  );
}

/** Where an output pays, as text: its address, or what its script is. */
function Destination(props: { out: KeptOutput }) {
  return (
    <Switch>
      <Match when={props.out.address} keyed>
        {(a) => <Hash value={a} href={paths.address(a)} copy={false} head={10} tail={6} />}
      </Match>
      <Match when={props.out.script !== undefined}>
        <span class="tx-compare__script">
          {classify(props.out.script ?? "").label}
          <Show when={(props.out.script ?? "").length > 0}>
            {" "}
            <span class="hash">{(props.out.script ?? "").slice(0, 16)}</span>
          </Show>
        </span>
      </Match>
      <Match when={true}>
        <span class="tx-compare__script">
          Script of {groupDigits(props.out.scriptLen ?? 0)} bytes{" "}
          <span class="hash" title="The start of its SHA-256: the server keeps no more">
            #{(props.out.scriptHash ?? "").slice(0, 8)}
          </span>
        </span>
      </Match>
    </Switch>
  );
}

function OutputRow(props: { row: OutputChange }) {
  const r = () => props.row;
  const out = () =>
    r().kind === "removed"
      ? (r() as { before: KeptOutput }).before
      : (r() as { after: KeptOutput }).after;
  return (
    <li class={`tx-compare__out tx-compare__out--${r().kind}`}>
      <span class="tx-compare__kind">
        <span class="tx-compare__glyph" aria-hidden="true">
          {KIND[r().kind].glyph}
        </span>
        {KIND[r().kind].word}
      </span>
      <span class="tx-compare__to">
        <Destination out={out()} />
      </span>
      <span class="tx-compare__amounts">
        <Switch>
          <Match when={r().kind === "changed" && (r() as OutputChange & { kind: "changed" })} keyed>
            {(c) => (
              <>
                <Amount sats={c.after.value} />
                <span class="tx-compare__was">
                  was <Amount sats={c.before.value} />, <Amount sats={c.delta} signed />
                </span>
              </>
            )}
          </Match>
          <Match when={r().kind === "removed"}>
            <span class="tx-compare__struck">
              <Amount sats={out().value} />
            </span>
          </Match>
          <Match when={true}>
            <Amount sats={out().value} />
          </Match>
        </Switch>
      </span>
    </li>
  );
}

/**
 * {@link Compare} with the pair held here: for a line no other control picks from (a version that
 * replaced others compares itself with the one before).
 */
export function CompareLine(props: { versions: string[]; here: string }) {
  const last = () => props.versions.length - 1;
  const [pair, setPair] = createSignal<[string, string]>();
  const at = (t: string) => props.versions.indexOf(t);
  const shown = (): [number, number] => {
    const p = pair();
    return p && at(p[0]) >= 0 && at(p[1]) >= 0 ? [at(p[0]), at(p[1])] : [last() - 1, last()];
  };
  return (
    <Compare
      versions={props.versions}
      from={shown()[0]}
      to={shown()[1]}
      here={props.here}
      onPick={(f, t) => setPair([props.versions[f] ?? "", props.versions[t] ?? ""])}
    />
  );
}
