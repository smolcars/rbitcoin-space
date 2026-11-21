// Every word the privacy check says (docs/FRONTEND.md "Privacy check"): pure functions from the
// module's findings (lib/privacy.ts) to sentences, and from a report to the marks on the flow's
// cards. Each sentence says what an observer can read, never what the sender did. A sentence is a
// run of plain text and addresses; an address is attacker-controlled text the page sets as a text
// node, shortened as the site shortens addresses elsewhere.
import { groupDigits } from "../../lib/format";
import {
  type ChangeReading,
  type FindingKind,
  type PrivacyCheck,
  type PrivacyFinding,
  type PrivacyReport,
  type ReusedAddress,
  UNSENT_ONLY,
} from "../../lib/privacy";
import type { ScriptType } from "../../lib/esplora";

/** Plain text, or an address the page shows shortened, whole in its title. */
export type Piece = string | { address: string };
export type Sentence = readonly Piece[];

export type Tone = "caution" | "neutral";

/** What one finding says. */
export interface Said {
  kind: FindingKind;
  /** Caution: it gives something away. Neutral: a shape worth knowing, not a fault. */
  tone: Tone;
  title: string;
  body: Sentence[];
  /** The readings behind a change finding, one sentence each. */
  reasons: Sentence[];
}

/** Indexes listed by number up to this many; past it, counted. */
export const LISTED = 5;
/** Reused addresses said one by one up to this many; the rest are counted. */
export const ADDRESSES_SAID = 3;

const SATS = 100_000_000;

/** An amount as a sentence writes it: whole BTC grouped, the fraction without trailing zeros. */
export function btc(sats: number): string {
  const whole = groupDigits(Math.floor(sats / SATS));
  const fraction = String(sats % SATS)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} BTC`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "input 3", "inputs 0, 1 and 4", or past `LISTED`, "21 inputs". */
export function listed(word: "input" | "output", xs: readonly number[]): string {
  // A copy, sorted: the finding's own list is left as it is.
  const sorted = [...xs];
  sorted.sort((a, b) => a - b);
  if (sorted.length === 1) return `${word} ${sorted[0]}`;
  if (sorted.length > LISTED) return `${groupDigits(sorted.length)} ${word}s`;
  return `${word}s ${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}`;
}

const TYPE_NAMES: Partial<Record<ScriptType, string>> = {
  p2pkh: "P2PKH",
  p2sh: "P2SH",
  p2pk: "P2PK",
  v0_p2wpkh: "P2WPKH",
  v0_p2wsh: "P2WSH",
  v1_p2tr: "P2TR",
  multisig: "bare multisig",
};
const typeName = (t: ScriptType) => TYPE_NAMES[t] ?? t;

/** One reused address, in a sentence or two. */
function reusedSentence(a: ReusedAddress): Sentence {
  const { inputs, outputs } = a;
  const addr = { address: a.address };
  if (inputs.length > 0 && outputs.length > 0) {
    const ins = listed("input", inputs);
    const outs = listed("output", outputs);
    const spends = inputs.length === 1 ? "spends" : "spend";
    const pays = outputs.length === 1 ? "pays" : "pay";
    const thoseOut = outputs.length === 1 ? "that output" : "those outputs";
    const thoseIn = inputs.length === 1 ? "that input" : "those inputs";
    return [
      `${cap(ins)} ${spends} from `,
      addr,
      `, and ${outs} ${pays} the same address. An observer can tie ${thoseOut} to whoever controls ${thoseIn}.`,
    ];
  }
  if (inputs.length > 0)
    return [
      `${cap(listed("input", inputs))} all spend from `,
      addr,
      ". An observer can tie those coins to one owner, with anything else paid to that address.",
    ];
  return [
    `${cap(listed("output", outputs))} all pay `,
    addr,
    ". An observer can tie them to the same owner.",
  ];
}

/** A change reading as a reason for the output every reading agrees on ("it" is that output). */
function agreeing(r: ChangeReading): Sentence {
  const why = r.reason;
  if (why.kind === "payback") {
    const one = why.inputs.length === 1;
    return [
      `It pays back to the address ${listed("input", why.inputs)} ${one ? "spends" : "spend"} from, so it goes to whoever controls ${one ? "that input" : "those inputs"}.`,
    ];
  }
  if (why.kind === "round") {
    return [
      `Output ${why.roundOutput} is a round ${btc(why.value)} and this one is not, which suggests output ${why.roundOutput} is the payment.`,
    ];
  }
  if (why.kind === "script") {
    return [
      `It is the only output of the inputs' type, ${typeName(why.scriptType)}, which suggests it goes back to the same wallet.`,
    ];
  }
  // unneeded
  return [
    `It is less than ${smallest(why.inputs, why.value)}, and the other output is not. If the wallet would not add a coin it did not need, that suggests the other output is the payment.`,
  ];
}

/** A change reading as a plain fact, for readings that disagree: it names no output as change. */
function stated(r: ChangeReading): Sentence {
  const why = r.reason;
  if (why.kind === "payback") {
    return [
      `Output ${r.change} pays back to the address ${listed("input", why.inputs)} ${why.inputs.length === 1 ? "spends" : "spend"} from.`,
    ];
  }
  if (why.kind === "round") {
    return [
      `Output ${why.roundOutput} is a round ${btc(why.value)}, and output ${r.change} is not.`,
    ];
  }
  if (why.kind === "script") {
    return [`Only output ${r.change} is of the inputs' type, ${typeName(why.scriptType)}.`];
  }
  // unneeded
  return [
    `Output ${r.change} is less than ${smallest(why.inputs, why.value)}, and the other output is not.`,
  ];
}

/** The smallest coin spent, with the inputs it is: one input, or one address's inputs together. */
function smallest(inputs: readonly number[], value: number): string {
  return inputs.length === 1
    ? `${btc(value)}, the smallest coin spent (input ${inputs[0]})`
    : `${btc(value)}, the least spent from one address (${listed("input", inputs)})`;
}

const readingCount = (n: number) =>
  n === 1
    ? "Suggested by one reading, which is not proof:"
    : `Suggested by ${["", "", "two", "three", "four"][n] ?? groupDigits(n)} readings, none of them proof:`;

/** What a finding says. */
export function sayFinding(f: PrivacyFinding): Said {
  if (f.kind === "reuse") {
    const shown = f.addresses.slice(0, ADDRESSES_SAID);
    const more = f.addresses.length - shown.length;
    const body: Sentence[] = shown.map((a) => reusedSentence(a));
    if (more > 0)
      body.push([
        `${groupDigits(more)} more ${more === 1 ? "address appears" : "addresses appear"} more than once.`,
      ]);
    return {
      kind: f.kind,
      tone: "caution",
      title:
        f.addresses.length === 1
          ? "Address reused"
          : `${groupDigits(f.addresses.length)} addresses reused`,
      body,
      reasons: [],
    };
  }
  if (f.kind === "change") {
    return {
      kind: f.kind,
      tone: "caution",
      title:
        f.payment === undefined
          ? `Output ${f.change} reads as change`
          : `Output ${f.change} reads as change, output ${f.payment} as the payment`,
      body: [[readingCount(f.readings.length)]],
      reasons: f.readings.map((r) => agreeing(r)),
    };
  }
  if (f.kind === "change-disputed") {
    return {
      kind: f.kind,
      tone: "caution",
      title: "No output clearly reads as change",
      body: [["These readings point at different outputs, so none of them is strong:"]],
      reasons: f.readings.map((r) => stated(r)),
    };
  }
  if (f.kind === "coinjoin") {
    const [first] = f.groups;
    const equal = f.groups.reduce((n, g) => n + g.outputs.length, 0);
    const senders = `the inputs come from ${groupDigits(f.senders)} different addresses`;
    const shape =
      f.groups.length === 1 && first
        ? `${cap(listed("output", first.outputs))} each pay exactly ${btc(first.value)}, to different addresses, and ${senders}.`
        : `${groupDigits(equal)} outputs fall into ${groupDigits(f.groups.length)} groups of equal amounts, the largest ${groupDigits(first?.outputs.length ?? 0)} of ${btc(first?.value ?? 0)}, each to a different address, and ${senders}.`;
    return {
      kind: f.kind,
      tone: "neutral",
      title: "Shaped like a CoinJoin",
      body: [
        [shape],
        [
          "That is the shape of a CoinJoin, where several people pay into one transaction so an observer cannot tell which equal output is whose. The shape alone does not prove it is one, and which output is change is not read here.",
        ],
      ],
      reasons: [],
    };
  }
  // spent-together
  const from =
    f.addresses === 1
      ? ", all from one address"
      : `, from ${groupDigits(f.addresses)} different addresses`;
  const body: Sentence[] = [
    [
      `${cap(listed("input", f.inputs))} are spent together${from}. An observer can read coins spent in one transaction as one owner's.`,
    ],
  ];
  if (f.noChange) body.push(["There is one output and no change, so all of it goes to one place."]);
  return { kind: f.kind, tone: "caution", title: "Coins spent together", body, reasons: [] };
}

/** The findings a page shows: the transaction page leaves out those for an unsent transaction. */
export const shownFindings = (r: PrivacyReport, unsent: boolean): PrivacyFinding[] =>
  r.findings.filter((f) => unsent || !UNSENT_ONLY.has(f.kind));

const CHECK_NAMES: Record<PrivacyCheck, string> = {
  reuse: "address reuse",
  payback: "outputs paying back to an input's address",
  round: "round amounts",
  script: "script types",
  unneeded: "the smallest coin spent",
  coinjoin: "the CoinJoin shape",
  "spent-together": "coins spent together",
};

/** Finding kinds as `unreliable` names them; both change kinds are one subject to a reader. */
const SUBJECTS: Record<FindingKind, string> = {
  reuse: "address reuse",
  change: "which output is change",
  "change-disputed": "which output is change",
  coinjoin: "the CoinJoin shape",
  "spent-together": "coins spent together",
};

const andList = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** Whether only part of the transaction could be checked. */
export const isPartial = (r: PrivacyReport) =>
  r.inputsMissing || r.unknownInputs.length > 0 || r.notRun.length > 0 || r.unreliable.length > 0;

/**
 * What could not be checked, and what that may leave incomplete, as the report states it. Empty
 * when everything was checked. `unreliable` is conservative, so it says "may".
 */
export function sayPartial(r: PrivacyReport, unsent: boolean): Sentence[] {
  const out: Sentence[] = [];
  if (r.inputsMissing)
    out.push([
      "This transaction's inputs are not listed here, so only its outputs could be checked.",
    ]);
  else if (r.unknownInputs.length > 0) {
    const n = r.unknownInputs.length;
    out.push([
      `What ${listed("input", r.unknownInputs)} ${n === 1 ? "spends" : "spend"} is not known here, so only part of this transaction could be checked.`,
    ]);
  } else if (r.notRun.length > 0)
    out.push([
      "Some of its amounts cannot be right (more than there will ever be, or more paid out than spent), so only part of it could be checked.",
    ]);
  // An unsent-only check is named only where it would be shown.
  const notRun = r.notRun.filter((c) => unsent || c !== "spent-together");
  if (notRun.length > 0) out.push([`Not checked: ${andList(notRun.map((c) => CHECK_NAMES[c]))}.`]);
  const subjects = [
    ...new Set(r.unreliable.filter((k) => unsent || !UNSENT_ONLY.has(k)).map((k) => SUBJECTS[k])),
  ];
  if (subjects.length > 0)
    out.push([`What it shows about ${andList(subjects)} may be incomplete.`]);
  return out;
}

/** The one line for a transaction with no finding to show. */
export const sayNothing = (partial: boolean) =>
  partial
    ? "Nothing was found in the part that could be checked."
    : "Nothing in this transaction's shape stands out.";

/** The list's heading on the transaction page, and the notice's on Broadcast and the decoder. */
export const LIST_TITLE = "What an observer can read";
export const UNSENT_TITLE = "Once it is sent, anyone can read this from it";
export const UNSENT_CLOSING =
  "It is not sent yet: a wallet can still change which coins it spends and where the change goes.";

/** "What this checks": each check in a sentence, then what it does not do. */
export const CHECKS: readonly string[] = [
  "Address reuse: an address that appears more than once among this transaction's inputs and outputs.",
  "Which output is change, from four readings: one output paying back to an address an input spends from; one round amount beside one that is not; the only output of the inputs' script type; and the smaller output being less than the smallest coin spent while the larger is not. A pay-back decides; readings that point at different outputs leave it unclear.",
  "The shape of a CoinJoin: three or more outputs of one amount, each to a different address, from at least as many different addresses.",
  "Coins spent together, which suggest one owner; shown only before a transaction is sent, while that can still change.",
];
export const LIMITS: readonly string[] = [
  "It does not look at earlier transactions, so an address used before this one is not noticed.",
  "It knows amounts round in bitcoin only, not a payment round in another currency.",
  "These are readings anyone can make, not proof, and nothing here makes a transaction private.",
];

/** A card's mark: a few words, with the tone of the finding behind them. */
export interface Mark {
  text: string;
  tone: Tone;
}

/** Marks for the flow's cards, keyed `in:N` and `out:N`, from the findings a page shows. */
export function cardMarks(findings: readonly PrivacyFinding[]): Map<string, Mark[]> {
  const marks = new Map<string, Mark[]>();
  const add = (key: string, mark: Mark) => {
    const xs = marks.get(key);
    if (!xs) marks.set(key, [mark]);
    else if (!xs.some((m) => m.text === mark.text)) xs.push(mark);
  };
  const reused: Mark = { text: "Reused address", tone: "caution" };
  for (const f of findings) {
    if (f.kind === "reuse")
      for (const a of f.addresses) {
        for (const i of a.inputs) add(`in:${i}`, reused);
        for (const o of a.outputs) add(`out:${o}`, reused);
      }
    if (f.kind === "change") {
      add(`out:${f.change}`, { text: "Reads as change", tone: "caution" });
      if (f.payment !== undefined)
        add(`out:${f.payment}`, { text: "Reads as payment", tone: "caution" });
    }
    if (f.kind === "coinjoin")
      for (const g of f.groups)
        for (const o of g.outputs) add(`out:${o}`, { text: "Equal amount", tone: "neutral" });
  }
  return marks;
}

/** A sentence as plain text, addresses shortened by `short`, for tests and screen-reader checks. */
export const plain = (s: Sentence, short: (a: string) => string = (a) => a): string =>
  s.map((p) => (typeof p === "string" ? p : short(p.address))).join("");
