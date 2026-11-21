import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Amount } from "../../components/Amount";
import { Hash } from "../../components/Hash";
import { scriptKey } from "../../lib/address";
import type { Outspend, Transaction, Vin, Vout } from "../../lib/esplora";
import { formatSize, groupDigits } from "../../lib/format";
import type { Lookalike } from "../../lib/lookalike";
import { paths } from "../../lib/network";
import type { TagPart } from "../block/chain";
import {
  coinbaseText,
  inputText,
  inscriptionOf,
  isTextInscription,
  outputText,
  tapscript,
} from "./chaintext";
import { Code } from "./Code";
import { ChainWords, type Selection } from "./Flow";
import { MarkedAddress } from "./Lookalike";
import { returnFocus } from "./flash";
import { classify, disassemble, isText, lastPush, opReturnData } from "./script";
import {
  coinbaseHeight,
  formatSequence,
  MORE_STEP,
  SHOW_ALL_MAX,
  sequenceMeaning,
  whyUnspendable,
} from "./tx";

/** Witness items listed at first; each "Show more" adds MORE_STEP. */
const WITNESS_SHOWN = 24;

const asm = (hex: string) => disassemble(hex, SHOW_ALL_MAX);

function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="tx-fact">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** A script as hex and as assembly. */
function Script(props: { label: string; hex: string }) {
  const a = createMemo(() => asm(props.hex));
  return (
    <>
      <Code label={`${props.label}, hex`} value={props.hex} bytes={props.hex.length / 2} />
      <Show when={props.hex !== ""}>
        <Code
          label={`${props.label}, assembly`}
          value={a().text}
          cut={a().truncated}
          copy={false}
        />
      </Show>
    </>
  );
}

/** Text someone wrote on the chain, whole, in the reading font: text nodes only. */
function TextWell(props: { label: string; parts: TagPart[] }) {
  return (
    <div class="tx-code">
      <div class="tx-code__head">
        <span class="tx-code__label">{props.label}</span>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling box must take focus so the keyboard can scroll it */}
      <p class="tx-text" tabindex="0">
        <ChainWords parts={props.parts} />
      </p>
    </div>
  );
}

/** Everything about one input or output: scripts, witness, sequence, what it spends or what spent it. */
export function Inspector(props: {
  tx: Transaction;
  selected: Selection;
  outspends: () => Outspend[] | null | undefined;
  onClose: () => void;
  ref: (el: HTMLHeadingElement) => void;
  /** Lookalike addresses handed over from an address page, by address. */
  lookalike?: ReadonlyMap<string, Lookalike> | undefined;
  /** False for a transaction the node does not have: no output says whether it is spent. */
  known?: boolean | undefined;
}) {
  const title = () =>
    `${props.selected.side === "in" ? "Input" : "Output"} ${props.selected.index}`;
  // Closed, they give the focus back to what opened them (flash.ts `returnFocus`), so a keyboard
  // reader carries on from where they were.
  const close = () => {
    const { side, index } = props.selected;
    props.onClose();
    requestAnimationFrame(() => returnFocus(side, index));
  };
  return (
    <section class="tx-inspector" id="tx-inspector" aria-labelledby="tx-inspector-title">
      <div class="tx-inspector__head">
        <h3 id="tx-inspector-title" tabindex="-1" ref={props.ref}>
          {title()}
        </h3>
        <button class="btn" type="button" onClick={close}>
          Close
        </button>
      </div>
      <Switch>
        <Match when={props.selected.side === "in" && props.tx.vin?.[props.selected.index]}>
          {(vin) => <InputDetails vin={vin()} tx={props.tx} lookalike={props.lookalike} />}
        </Match>
        <Match when={props.selected.side === "out" && props.tx.vout[props.selected.index]}>
          {(vout) => (
            <OutputDetails
              vout={vout()}
              spend={props.outspends()?.[props.selected.index]}
              failed={props.outspends() === null}
              unspendable={whyUnspendable(props.tx, vout())}
              lookalike={props.lookalike}
              known={props.known !== false}
            />
          )}
        </Match>
      </Switch>
    </section>
  );
}

/** The key a pay-to-pubkey output pays, linked to its page: it has no address. Else "None". */
function Key(props: { out: Vout }) {
  return (
    <Show when={scriptKey(props.out.scriptpubkey)} fallback="None">
      {(k) => (
        <Hash
          value={k()}
          href={paths.address(k())}
          head={14}
          tail={10}
          copyLabel="Copy public key"
        />
      )}
    </Show>
  );
}

/** An input's or output's address: marked whole when it is a lookalike handed over, else short. */
function Address(props: {
  address: string;
  lookalike: ReadonlyMap<string, Lookalike> | undefined;
}) {
  return (
    <Show
      when={props.lookalike?.get(props.address)}
      fallback={
        <Hash
          value={props.address}
          href={paths.address(props.address)}
          head={14}
          tail={10}
          copyLabel="Copy address"
        />
      }
    >
      {(l) => <MarkedAddress l={l()} />}
    </Show>
  );
}

function InputDetails(props: {
  vin: Vin;
  tx: Transaction;
  lookalike: ReadonlyMap<string, Lookalike> | undefined;
}) {
  const inscription = createMemo(() => inscriptionOf(props.vin));
  const text = createMemo(() => inputText(props.vin, SHOW_ALL_MAX)?.parts ?? null);
  const coinbase = createMemo(() =>
    props.vin.is_coinbase ? (coinbaseText(props.tx)?.parts ?? null) : null,
  );
  const height = () => props.tx.status?.block_height;
  const prevKind = () =>
    props.vin.prevout ? classify(props.vin.prevout.scriptpubkey).kind : undefined;
  const witness = () => props.vin.witness ?? [];
  // The script a P2SH, P2WSH or taproot script-path spend reveals, named the way its type names it.
  const inner = createMemo((): { label: string; hex: string } | null => {
    const w = witness();
    const kind = prevKind();
    if (kind === "p2wsh" && w.length > 0) return { label: "Witness script", hex: w.at(-1) ?? "" };
    if (kind === "p2tr") {
      const t = tapscript(props.vin);
      return t === null ? null : { label: "Tapscript", hex: t };
    }
    if (kind === "p2sh") {
      const redeem = lastPush(props.vin.scriptsig ?? "");
      if (!redeem) return null;
      const c = classify(redeem).kind;
      if (c === "p2wsh" && w.length > 0) return { label: "Witness script", hex: w.at(-1) ?? "" };
      return { label: "Redeem script", hex: redeem };
    }
    return null;
  });
  const [witnessPresses, setWitnessPresses] = createSignal(0);
  const witnessShown = () =>
    Math.min(witness().length, WITNESS_SHOWN + witnessPresses() * MORE_STEP);
  return (
    <>
      <dl class="tx-facts">
        <Show
          when={!props.vin.is_coinbase}
          fallback={
            <>
              <Fact label="Spends">New coins: this is a coinbase</Fact>
              <Show when={coinbaseHeight(props.vin.scriptsig, height())}>
                {(h) => <Fact label="Block height in script">{groupDigits(h())}</Fact>}
              </Show>
            </>
          }
        >
          <Fact label="Spends">
            <span class="tx-outpoint">
              <Hash
                value={props.vin.txid}
                href={paths.tx(props.vin.txid)}
                copyLabel="Copy transaction ID"
              />
              <span class="num">:{props.vin.vout}</span>
            </span>
          </Fact>
          <Show when={props.vin.prevout}>
            {(p) => (
              <>
                <Fact label="Amount">
                  <Amount sats={p().value} />
                </Fact>
                <Fact label={scriptKey(p().scriptpubkey) ? "Public key" : "Address"}>
                  <Show when={p().scriptpubkey_address} fallback={<Key out={p()} />}>
                    {(a) => <Address address={a()} lookalike={props.lookalike} />}
                  </Show>
                </Fact>
                <Fact label="Script type">{classify(p().scriptpubkey).label}</Fact>
              </>
            )}
          </Show>
          <Show when={inscription()}>
            {(ins) => (
              <Fact label="Inscription">
                <span class="tx-fact__wrap">{ins().contentType || "No content type"}</span>
                <span class="tx-fact__sub num">
                  {formatSize(ins().size, "B")}
                  {isTextInscription(ins()) ? "" : ", not shown"}
                </span>
              </Fact>
            )}
          </Show>
        </Show>
        <Show when={props.vin.sequence !== undefined}>
          <Fact label="Sequence">
            <span class="num">{formatSequence(props.vin.sequence ?? 0)}</span>
            <span class="tx-fact__sub">
              {sequenceMeaning(props.vin.sequence ?? 0, props.tx.version)}
            </span>
          </Fact>
        </Show>
      </dl>
      <div class="tx-codes">
        <Show when={coinbase()}>
          {(parts) => <TextWell label="Coinbase text" parts={parts()} />}
        </Show>
        <Show when={text()}>
          {(parts) => <TextWell label="Inscription text" parts={parts()} />}
        </Show>
        <Show when={(props.vin.scriptsig ?? "") !== ""}>
          <Script
            label={props.vin.is_coinbase ? "Coinbase script" : "Unlocking script (scriptSig)"}
            hex={props.vin.scriptsig ?? ""}
          />
        </Show>
        <Show when={witness().length > 0}>
          <div class="tx-witness">
            <p class="tx-witness__title">
              Witness, {groupDigits(witness().length)} item{witness().length === 1 ? "" : "s"}
            </p>
            <For each={witness().slice(0, witnessShown())}>
              {(item, i) => <Code label={`Item ${i()}`} value={item} bytes={item.length / 2} />}
            </For>
            <Show when={witness().length > witnessShown()}>
              <button class="btn" type="button" onClick={() => setWitnessPresses((n) => n + 1)}>
                Show {groupDigits(Math.min(witness().length - witnessShown(), MORE_STEP))} more of{" "}
                {groupDigits(witness().length)} items
              </button>
            </Show>
          </div>
        </Show>
        <Show when={inner()}>{(s) => <Script label={s().label} hex={s().hex} />}</Show>
        <Show when={props.vin.prevout}>
          {(p) => <Script label="Spent output's script" hex={p().scriptpubkey} />}
        </Show>
      </div>
    </>
  );
}

function OutputDetails(props: {
  vout: Vout;
  spend: Outspend | undefined;
  failed: boolean;
  unspendable: string | null;
  lookalike: ReadonlyMap<string, Lookalike> | undefined;
  known: boolean;
}) {
  const kind = () => classify(props.vout.scriptpubkey);
  const data = createMemo(() =>
    kind().kind === "op_return" ? opReturnData(props.vout.scriptpubkey) : null,
  );
  return (
    <>
      <dl class="tx-facts">
        <Fact label="Amount">
          <Amount sats={props.vout.value} />
        </Fact>
        <Fact label={scriptKey(props.vout.scriptpubkey) ? "Public key" : "Address"}>
          <Show when={props.vout.scriptpubkey_address} fallback={<Key out={props.vout} />}>
            {(a) => <Address address={a()} lookalike={props.lookalike} />}
          </Show>
        </Fact>
        <Fact label="Script type">{kind().label}</Fact>
        {/* An output of a transaction nobody has yet is neither spent nor unspent. */}
        <Show when={props.known || props.unspendable}>
          <Fact label="Spent">
            <Switch fallback="Checking…">
              <Match when={props.unspendable}>{(why) => <>{`Unspendable: ${why()}`}</>}</Match>
              <Match when={props.failed}>
                Could not check right now. Reload the page to try again.
              </Match>
              <Match when={props.spend?.spent === false}>No</Match>
              <Match when={props.spend?.spent && props.spend.txid}>
                {(by) => (
                  <span class="tx-outpoint">
                    <Show when={props.spend?.status?.confirmed === false}>
                      Being spent, unconfirmed, by{" "}
                    </Show>
                    <Hash value={by()} href={paths.tx(by())} copyLabel="Copy transaction ID" />
                    <Show when={props.spend?.vin !== undefined}>
                      <span class="num">, input {props.spend?.vin}</span>
                    </Show>
                  </span>
                )}
              </Match>
            </Switch>
          </Fact>
        </Show>
      </dl>
      <div class="tx-codes">
        <Show when={data()}>
          {(d) => (
            <Show
              when={isText(d())}
              fallback={
                <Code
                  label="Data"
                  value={[...d()].map((b) => b.toString(16).padStart(2, "0")).join("")}
                  bytes={d().length}
                />
              }
            >
              <TextWell
                label="OP_RETURN text"
                parts={outputText(props.vout, SHOW_ALL_MAX)?.parts ?? []}
              />
            </Show>
          )}
        </Show>
        <Script label="Locking script (scriptPubKey)" hex={props.vout.scriptpubkey} />
      </div>
    </>
  );
}
