// A silent payments address: what a sender needs, read from the address alone. Nothing is asked of
// the server, since nothing on chain names the address.
import { createMemo, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { HashFull } from "../../components/Hash";
import { More } from "../../components/More";
import { SectionHeader } from "../../components/SectionHeader";
import { NETWORK_NAMES, type Network } from "../../lib/network";
import { Notice } from "./parts";
import { decodeSilentPayment, type SilentPaymentProblem } from "./silent-payment";

const PROBLEMS: Record<SilentPaymentProblem, string> = {
  checksum: "Its checksum does not match: a character is wrong, missing or out of place.",
  version: "Version 31 is kept for a future format, and no wallet pays it.",
  length: "It holds the wrong amount of data for its version.",
  key: "One of its two keys is not a valid public key, so no wallet can pay it.",
};

/** A silent payments address on the network the page shows (AddressPage checks that). */
export function SilentPaymentAddress(props: { address: string; network: Network }) {
  const decoded = createMemo(() => decodeSilentPayment(props.address));
  const valid = () => {
    const d = decoded();
    return d.ok ? d : undefined;
  };
  const problem = () => {
    const d = decoded();
    return d.ok ? undefined : d.problem;
  };
  return (
    <Switch>
      <Match when={problem()}>
        {(p) => (
          <Notice title="This is not a valid silent payments address" tone="caution">
            {PROBLEMS[p()]}
          </Notice>
        )}
      </Match>
      <Match when={valid()}>
        {(sp) => (
          <>
            <p class="address-sp-valid">
              <svg class="address-sp-valid__icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
              <span class="address-sp-valid__label">Valid</span>
              <span class="address-sp-valid__detail">
                Silent payments address for {NETWORK_NAMES[props.network]}
              </span>
            </p>
            <Show when={sp().version > 0}>
              <Notice title={`A newer version: ${sp().version}`} tone="caution">
                A wallet made for version 0 may not pay it.
              </Notice>
            </Show>
            <section class="address-sp" aria-labelledby="address-sp-pay">
              <SectionHeader title="Pay this address" id="address-sp-pay" />
              <p class="address-sp__text">Copy it into a wallet that supports silent payments.</p>
              <More label="How silent payments work">
                <p>
                  There is no balance or history to show: no payment names this address on chain,
                  and only its owner can find the payments made to it.
                </p>
                <p>
                  The address holds two public keys. A sending wallet combines the scan key with the
                  private keys of the coins it spends, and uses the result to tweak the spend key
                  into a new taproot output. On chain it looks like any other taproot output, and no
                  two payments share one.
                </p>
                <p>
                  The receiver finds its payments by checking each block's transactions with the
                  private half of its scan key. An explorer has neither private key, so it cannot
                  list them. A version above 0 is read by its first 66 bytes, as BIP352 asks. The
                  format is defined in BIP352.
                </p>
              </More>
            </section>
            <section class="address-sp" aria-labelledby="address-sp-keys">
              <SectionHeader title="What the address holds" id="address-sp-keys" />
              <dl class="address-sp-facts">
                <Fact label="Network">
                  {NETWORK_NAMES[props.network]}{" "}
                  <span class="muted">({props.network === "mainnet" ? "sp" : "tsp"})</span>
                </Fact>
                <Fact label="Version">
                  {/* As text: a bare 0 renders nothing. */}
                  <span class="num">{String(sp().version)}</span>
                  <Show when={sp().extraBytes > 0}>
                    <span class="muted">{` (${plural(sp().extraBytes)} this page does not read)`}</span>
                  </Show>
                </Fact>
                <Fact label="Scan key">
                  <HashFull value={sp().scanKey} copyLabel="Copy the scan key, as hex" />
                </Fact>
                <Fact label="Spend key">
                  <HashFull value={sp().spendKey} copyLabel="Copy the spend key, as hex" />
                </Fact>
              </dl>
            </section>
          </>
        )}
      </Match>
    </Switch>
  );
}

const plural = (n: number) => `${n} more ${n === 1 ? "byte" : "bytes"}`;

function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="address-sp-fact">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}
