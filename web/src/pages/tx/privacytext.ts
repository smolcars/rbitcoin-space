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

// Characters that would not show, or would reorder or disguise the text around them, as the block
// page's tag defines them (pages/block/chain.ts): each is shown as a replacement character.
const HIDDEN_ONE = /^[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]$/u;
/** An address's title is cut past this many characters. */
export const TITLE_MAX = 128;

/**
 * An address as a sentence shows it: cut to its first and last eight characters as the site
 * shortens addresses, each hidden character a replacement character; and its title whole up to
 * `TITLE_MAX` characters, each hidden character written as its code point (`\u{202E}`, a
 * backslash as `\\`), so two different strings never share a title; and `cut`, where in `short` a
 * line may break (after its "…"), 0 when it is whole.
 */
export function shownAddress(address: string): { short: string; title: string; cut: number } {
  // By code point, so a character outside the basic plane is never cut in half.
  const chars = address.match(/[\s\S]/gu) ?? [];
  const seen = chars.map((c) => (HIDDEN_ONE.test(c) ? "\uFFFD" : c));
  const head = seen.length > 17 ? `${seen.slice(0, 8).join("")}…` : "";
  const short = head ? `${head}${seen.slice(-8).join("")}` : seen.join("");
  const escaped = chars
    .slice(0, TITLE_MAX)
    .map((c) =>
      c === "\\"
        ? "\\\\"
        : HIDDEN_ONE.test(c)
          ? `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`
          : c,
    );
  const title = `${escaped.join("")}${chars.length > TITLE_MAX ? "…" : ""}`;
  // Where a line may break: after the "…" this function put there, never one in the address.
  return { short, title, cut: head.length };
}

/** An input or an output, by its index: the page links it to its card. */
export interface Ref {
  ref: "in" | "out";
  index: number;
}
/** Plain text, an address the page shows shortened, whole in its title, or a card's index. */
export type Piece = string | { address: string } | Ref;
export type Sentence = readonly Piece[];

const ref = (side: "in" | "out", index: number): Ref => ({ ref: side, index });
/** A sentence from its parts, runs of pieces flattened. */
const says = (...parts: (Piece | Sentence)[]): Piece[] => {
  const out: Piece[] = [];
  for (const p of parts.flatMap((x) => (Array.isArray(x) ? (x as Piece[]) : [x as Piece]))) {
    // Neighbouring text is one piece, so a number's punctuation is always the start of the next.
    const last = out.at(-1);
    if (typeof p === "string" && typeof last === "string") out[out.length - 1] = last + p;
    else if (p !== "") out.push(p);
  }
  return out;
};

/** What the rules counted, named: an address, or a locking script when not every one has one. */
const scriptWord = (allAddresses: boolean, many: boolean) =>
  allAddresses ? (many ? "addresses" : "address") : many ? "locking scripts" : "locking script";

export type Tone = "caution" | "neutral";

/** What one finding says. */
export interface Said {
  kind: FindingKind;
  /** Caution: it gives something away. Neutral: a shape worth knowing, not a fault. */
  tone: Tone;
  title: Sentence;
  body: Sentence[];
  /** The readings behind a change finding, one sentence each. */
  reasons: Sentence[];
  /** A few words after the title, muted: when the finding is shown. */
  note?: string;
}

/** Where a finding sits on the page, for the marks that link to it. */
export const findingId = (kind: FindingKind) => `pv-${kind}`;

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
/** A sentence with its first letter capitalised. */
const capS = (s: Sentence): Piece[] => {
  const [first, ...rest] = s;
  return typeof first === "string" ? [cap(first), ...rest] : [...s];
};

/** "input 3", "inputs 0, 1 and 4", each index a link to its card; past `LISTED`, "21 inputs",
 * counted, linking nothing. */
export function listedRefs(word: "input" | "output", xs: readonly number[]): Piece[] {
  // A copy, sorted: the finding's own list is left as it is.
  const sorted = [...xs];
  sorted.sort((a, b) => a - b);
  const side = word === "input" ? "in" : "out";
  if (sorted.length > LISTED) return [`${groupDigits(sorted.length)} ${word}s`];
  if (sorted.length === 1) return [`${word} `, ref(side, sorted[0] ?? 0)];
  const out: Piece[] = [`${word}s `];
  sorted.forEach((x, k) => {
    if (k > 0) out.push(k === sorted.length - 1 ? " and " : ", ");
    out.push(ref(side, x));
  });
  return out;
}

/** `listedRefs` as plain text. */
export const listed = (word: "input" | "output", xs: readonly number[]): string =>
  plain(listedRefs(word, xs));

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

/** What a reused script is called: its address, or "locking script" when the rules say it has none. */
const what = (isAddress: boolean) => (isAddress ? "address" : "locking script");

/** One reused address, or script, in a sentence or two: the match, then what an observer may read. */
function reusedSentence(a: ReusedAddress): Sentence {
  const { inputs, outputs } = a;
  const addr = { address: a.address };
  const it = what(a.isAddress);
  const owner = "an observer may read them as one owner's";
  if (inputs.length > 0 && outputs.length > 0) {
    const ins = listedRefs("input", inputs);
    const outs = listedRefs("output", outputs);
    const spends = inputs.length === 1 ? "spends" : "spend";
    const pays = outputs.length === 1 ? "pays" : "pay";
    return says(
      capS(ins),
      ` ${spends} from ${it === "address" ? "" : "the locking script "}`,
      addr,
      " and ",
      outs,
      ` ${pays} it too: ${owner}.`,
    );
  }
  if (inputs.length > 0)
    return says(
      capS(listedRefs("input", inputs)),
      ` ${inputs.length === 2 ? "both" : "all"} spend from ${it === "address" ? "" : "the locking script "}`,
      addr,
      `: ${owner}, with anything else paid to it.`,
    );
  return says(
    capS(listedRefs("output", outputs)),
    ` ${outputs.length === 2 ? "both" : "all"} pay ${it === "address" ? "" : "the locking script "}`,
    addr,
    `: ${owner}.`,
  );
}

/** A change reading as a reason for the output every reading agrees on ("it" is that output). */
function agreeing(r: ChangeReading): Sentence {
  const why = r.reason;
  if (why.kind === "payback") {
    return says(
      `It pays the same ${what(why.isAddress)} `,
      listedRefs("input", why.inputs),
      ` ${why.inputs.length === 1 ? "spends" : "spend"} from.`,
    );
  }
  if (why.kind === "round") {
    return says(
      "Output ",
      ref("out", why.roundOutput),
      ` is a round ${btc(why.value)} and this one is not.`,
    );
  }
  if (why.kind === "script") {
    return [
      `Every input that funds it is ${typeName(why.scriptType)}, and of the two outputs checked only this one is.`,
    ];
  }
  // unneeded
  return says(
    "It is less than ",
    least(why.inputs, why.value, why.allAddresses),
    ", and the other output checked is not.",
  );
}

/**
 * A change reading for readings that disagree: first what it suggests ("Change:" or "Payment:"),
 * since there the direction is what disagrees, then its comparison as a plain fact.
 */
function stated(r: ChangeReading): Sentence {
  const why = r.reason;
  const change = ref("out", r.change);
  if (why.kind === "payback") {
    return says(
      "Change: output ",
      change,
      ` pays the same ${what(why.isAddress)} `,
      listedRefs("input", why.inputs),
      ` ${why.inputs.length === 1 ? "spends" : "spend"} from.`,
    );
  }
  if (why.kind === "round") {
    return says(
      "Payment: output ",
      ref("out", why.roundOutput),
      ` is a round ${btc(why.value)}, and output `,
      change,
      " is not.",
    );
  }
  if (why.kind === "script") {
    return says(
      `Change: of the two outputs checked only output `,
      change,
      ` is ${typeName(why.scriptType)}, as is every input that funds it.`,
    );
  }
  // unneeded
  return says(
    "Change: output ",
    change,
    " is less than ",
    least(why.inputs, why.value, why.allAddresses),
    ", and the other output checked is not.",
  );
}

/**
 * What the smallest-coin reading compared: the total spent from each address, the least of them,
 * and the input or inputs it is. Never "the smallest coin": a smaller single input may come from
 * an address that spends more in all.
 */
function least(inputs: readonly number[], value: number, allAddresses: boolean): Piece[] {
  return says(
    `${btc(value)}, the least spent from any one funding ${scriptWord(allAddresses, false)} (`,
    listedRefs("input", inputs),
    ")",
  );
}

const NUMBERS = ["", "one", "two", "three", "four"];
const readingCount = (n: number) =>
  n === 1
    ? "Suggested by one reading, which is not proof:"
    : n === 2
      ? "Suggested by two readings, neither of them proof:"
      : `Suggested by ${NUMBERS[n] ?? groupDigits(n)} readings, none of them proof:`;

/** The reused addresses and scripts not said one by one, counted. */
function moreReused(rest: readonly ReusedAddress[]): string {
  const scripts = rest.filter((a) => !a.isAddress).length;
  const addresses = rest.length - scripts;
  const some = (k: number, one: string, many: string) =>
    `${groupDigits(k)} ${k === 1 ? one : many}`;
  const verb = rest.length === 1 ? "appears" : "appear";
  if (scripts === 0)
    return `${some(addresses, "more address", "more addresses")} ${verb} more than once.`;
  if (addresses === 0)
    return `${some(scripts, "more locking script", "more locking scripts")} ${verb} more than once.`;
  return `${some(addresses, "more address", "more addresses")} and ${some(scripts, "locking script", "locking scripts")} appear more than once.`;
}

/** "Address reused", "Locking script reused", or how many of each. */
function reusedTitle(all: readonly ReusedAddress[]): string {
  const scripts = all.filter((a) => !a.isAddress).length;
  const addresses = all.length - scripts;
  const n = (k: number, one: string, many: string) => (k === 1 ? one : `${groupDigits(k)} ${many}`);
  if (scripts === 0) return n(addresses, "Address reused", "addresses reused");
  if (addresses === 0) return n(scripts, "Locking script reused", "locking scripts reused");
  return `${n(addresses, "1 address", "addresses")} and ${n(scripts, "1 locking script", "locking scripts")} reused`;
}

/**
 * The reused address behind a change finding whose one reading is a pay-back to it, when the
 * reuse finding beside it names that address alone: then the change finding points at it rather
 * than restating it.
 */
function paidBack(f: PrivacyFinding, all: readonly PrivacyFinding[]): ReusedAddress | undefined {
  if (f.kind !== "change" || f.readings.length !== 1) return undefined;
  const why = f.readings[0]?.reason;
  if (why?.kind !== "payback") return undefined;
  const reuse = all.find((g) => g.kind === "reuse");
  if (reuse?.kind !== "reuse" || reuse.addresses.length !== 1) return undefined;
  const [a] = reuse.addresses;
  if (!a || a.isAddress !== why.isAddress || !a.outputs.includes(f.change)) return undefined;
  // One set, not a scan per input: a consolidation may spend tens of thousands from one script.
  const spent = new Set(a.inputs);
  return why.inputs.every((i) => spent.has(i)) ? a : undefined;
}

/** What a finding says; `all` is the list it is shown in, so it need not repeat another. */
export function sayFinding(f: PrivacyFinding, all: readonly PrivacyFinding[] = []): Said {
  if (f.kind === "reuse") {
    const shown = f.addresses.slice(0, ADDRESSES_SAID);
    const more = f.addresses.length - shown.length;
    const body: Sentence[] = shown.map((a) => reusedSentence(a));
    if (more > 0) body.push([moreReused(f.addresses.slice(ADDRESSES_SAID))]);
    return {
      kind: f.kind,
      tone: "caution",
      title: [reusedTitle(f.addresses)],
      body,
      reasons: [],
    };
  }
  if (f.kind === "change") {
    const title = says(
      "Output ",
      ref("out", f.change),
      " reads as change",
      f.payment === undefined ? [] : [", output ", ref("out", f.payment), " as the payment"],
    );
    const back = paidBack(f, all);
    if (back)
      return {
        kind: f.kind,
        tone: "caution",
        title,
        body: [
          [
            `Suggested by one reading, which is not proof: it pays the reused ${what(back.isAddress)}.`,
          ],
        ],
        reasons: [],
      };
    return {
      kind: f.kind,
      tone: "caution",
      title,
      body: [[readingCount(f.readings.length)]],
      reasons: f.readings.map((r) => agreeing(r)),
    };
  }
  if (f.kind === "change-disputed") {
    return {
      kind: f.kind,
      tone: "caution",
      title: ["No output clearly reads as change"],
      body: [
        [f.readings.length === 2 ? "These two readings disagree:" : "These readings disagree:"],
      ],
      reasons: f.readings.map((r) => stated(r)),
    };
  }
  if (f.kind === "coinjoin") {
    const [first] = f.groups;
    const equal = f.groups.reduce((n, g) => n + g.outputs.length, 0);
    const senders = `the inputs that fund it spend from ${groupDigits(f.senders)} different ${scriptWord(f.sendersAreAddresses, true)}`;
    const to = scriptWord(
      f.groups.every((g) => g.toAddresses),
      false,
    );
    const shape: Sentence =
      f.groups.length === 1 && first
        ? says(
            capS(listedRefs("output", first.outputs)),
            ` each pay exactly ${btc(first.value)} to a different ${to}, and ${senders}.`,
          )
        : [
            `${groupDigits(equal)} outputs fall into ${groupDigits(f.groups.length)} groups of equal amounts, the largest ${groupDigits(first?.outputs.length ?? 0)} of ${btc(first?.value ?? 0)}. Within each group every output pays a different ${to}, and ${senders}.`,
          ];
    return {
      kind: f.kind,
      tone: "neutral",
      title: ["Shaped like a CoinJoin"],
      body: [
        shape,
        [
          "Their amounts alone do not tell an observer which is whose. It may be a CoinJoin; the shape alone does not prove it.",
        ],
      ],
      reasons: [],
    };
  }
  // spent-together
  const from =
    f.addresses === 1
      ? `, all from one ${scriptWord(f.allAddresses, false)}`
      : `, from ${groupDigits(f.addresses)} different ${scriptWord(f.allAddresses, true)}`;
  const body: Sentence[] = [
    says(
      capS(listedRefs("input", f.inputs)),
      ` are spent together${from}: an observer may read them as one owner's.`,
    ),
  ];
  if (f.noChange)
    body.push([
      "Only one output is paid, other than data or a fee anchor, so nothing in it reads as change.",
    ]);
  return {
    kind: f.kind,
    tone: "caution",
    title: ["Coins spent together"],
    note: SPENT_TOGETHER_NOTE,
    body,
    reasons: [],
  };
}

/** The findings a page shows: the transaction page leaves out those for an unsent transaction. */
export const shownFindings = (r: PrivacyReport, unsent: boolean): PrivacyFinding[] =>
  r.findings.filter((f) => unsent || !UNSENT_ONLY.has(f.kind));

const CHECK_NAMES: Record<PrivacyCheck, string> = {
  reuse: "address reuse",
  payback: "outputs paying back to an input's address",
  round: "round amounts",
  script: "script types",
  unneeded: "the least spent from one funding address",
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

/** Checks that need every input's coin, and checks that need valid amounts (lib/privacy.ts). */
const NEEDS_INPUTS: readonly PrivacyCheck[] = [
  "coinjoin",
  "payback",
  "script",
  "unneeded",
  "spent-together",
];
const NEEDS_AMOUNTS: readonly PrivacyCheck[] = ["coinjoin", "round", "unneeded"];

/**
 * What could not be checked, and why: each cause with the checks it held back, then what that may
 * leave incomplete. Empty when everything was checked. `unreliable` is conservative, so "may".
 * Amounts are named as a cause exactly when the report says they failed its check.
 */
export function sayPartial(r: PrivacyReport, unsent: boolean): Sentence[] {
  // An unsent-only check is named only where it would be shown.
  const notRun = r.notRun.filter((c) => unsent || c !== "spent-together");
  const amounts = !r.amountsValid;
  const held = (needs: readonly PrivacyCheck[]) => {
    const xs = notRun.filter((c) => needs.includes(c));
    return xs.length === 0
      ? "."
      : `, so ${xs.length === 1 ? "this was" : "these were"} not checked: ${andList(xs.map((c) => CHECK_NAMES[c]))}.`;
  };
  const out: Sentence[] = [];
  if (isPartial(r)) out.push(["Only part of this transaction could be checked."]);
  if (r.inputsMissing) out.push([`Its inputs are not listed here${held(NEEDS_INPUTS)}`]);
  else if (r.unknownInputs.length > 0) {
    const n = r.unknownInputs.length;
    out.push(
      says(
        "What ",
        listedRefs("input", r.unknownInputs),
        ` ${n === 1 ? "spends" : "spend"} is not known here${held(NEEDS_INPUTS)}`,
      ),
    );
  }
  if (amounts)
    out.push([
      `Some of its amounts cannot be right (more than there will ever be, or more paid out than spent)${held(NEEDS_AMOUNTS)}`,
    ]);
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

/**
 * The summary's line on a narrow screen, where the list sits under the flow: how many things an
 * observer can read, or that only part could be checked. Nothing when there is nothing to say.
 */
export function sayCount(r: PrivacyReport): string | null {
  const n = shownFindings(r, false).length;
  const part = isPartial(r);
  if (n === 0) return part ? `${LIST_TITLE}: only partly checked` : null;
  const things = `${groupDigits(n)} ${n === 1 ? "thing" : "things"} an observer can read`;
  return part ? `${things}, only partly checked` : things;
}

/** The summary line's eye: caution when anything shown gives something away; a CoinJoin's shape
 * alone, or only a partial check, is neutral. */
export const countTone = (r: PrivacyReport): Tone =>
  shownFindings(r, false).some((f) => f.kind !== "coinjoin") ? "caution" : "neutral";

/** After the title of a finding shown only before sending. */
export const SPENT_TOGETHER_NOTE = "Shown only before sending";

/** The list's heading on the transaction page, and the notice's on Broadcast and the decoder. */
export const LIST_TITLE = "What an observer can read";
export const UNSENT_TITLE = "Once it is sent, anyone can read this from it";
export const UNSENT_CLOSING =
  "It is not sent yet: a wallet can still change which coins it spends and where the change goes.";

/** One check in "What this checks": a sentence, and for change its readings, one item each. */
export interface Check {
  text: string;
  readings?: readonly string[];
  after?: string;
}

/** "What this checks": each check in a sentence, then what it does not do. */
export const CHECKS: readonly Check[] = [
  {
    text: "Address reuse: an address that appears more than once among the inputs that fund this transaction and the outputs it pays. An observer may read the coins at one address as one owner's.",
  },
  {
    text: "Which output is change, from four readings:",
    readings: [
      "When it pays two or more outputs, the only one paying the same address an input spends from, which an observer may read as going back to the sender. This one decides.",
      "Of the two outputs checked, a round amount (a multiple of 0.0001 BTC with at most two significant digits, such as 0.05 or 1.5 BTC) beside one that is not even a multiple of 0.00001 BTC: the round one suggests the payment.",
      "Every input that funds it of one script type, and only one of the two outputs checked of that type: it suggests the change.",
      "The smaller of the two outputs checked being less than the least spent from any one funding address, while the larger is not: if the wallet would not add coins it did not need, the larger suggests the payment.",
    ],
    after:
      "The last three look only at a transaction that pays exactly two outputs, the two outputs checked. Readings that point at different outputs leave it unclear, unless one is the pay-back, which decides. With more than one output paying an address an input spends from, no output is read as change.",
  },
  {
    text: "The shape of a CoinJoin, where several people pay into one transaction: among other conditions, three or more outputs of one amount, each to a different address, with the inputs that fund it from at least as many different addresses. Equal amounts alone do not tell which output is whose, though other things still may; on that shape, which output is change is not read.",
  },
  {
    text: "Coins spent together, which suggest one owner; shown only before a transaction is sent, while that can still change.",
  },
];
/** What the checks' words mean, said once before them. */
export const TERMS =
  "The inputs that fund it are all its inputs but any that spend a fee anchor (pay to anchor), and a funding address is one they spend from. The outputs it pays are all but data (OP_RETURN) and fee anchors. An address is one locking script; a locking script with no address is counted the same way and called a locking script.";
export const LIMITS: readonly string[] = [
  "It does not look at earlier transactions, so an address used before this one is not noticed.",
  "It knows amounts round in bitcoin only, not a payment round in another currency.",
  "These are readings anyone can make, not proof, and nothing here makes a transaction private.",
];

/** A card's mark: a few words, a word for a narrow card, the tone and the finding behind them. */
export interface Mark {
  text: string;
  short: string;
  tone: Tone;
  kind: FindingKind;
}

/** Marks for the flow's cards, keyed `in:N` and `out:N`, from the findings a page shows. */
export function cardMarks(findings: readonly PrivacyFinding[]): Map<string, Mark[]> {
  const marks = new Map<string, Mark[]>();
  const add = (key: string, mark: Mark) => {
    const xs = marks.get(key);
    if (!xs) marks.set(key, [mark]);
    else if (!xs.some((m) => m.text === mark.text)) xs.push(mark);
  };
  const reused = (isAddress: boolean): Mark => ({
    text: isAddress ? "Reused address" : "Reused script",
    short: "Reused",
    tone: "caution",
    kind: "reuse",
  });
  for (const f of findings) {
    if (f.kind === "reuse")
      for (const a of f.addresses) {
        for (const i of a.inputs) add(`in:${i}`, reused(a.isAddress));
        for (const o of a.outputs) add(`out:${o}`, reused(a.isAddress));
      }
    if (f.kind === "change") {
      add(`out:${f.change}`, {
        text: "Reads as change",
        short: "Change",
        tone: "caution",
        kind: "change",
      });
      if (f.payment !== undefined)
        add(`out:${f.payment}`, {
          text: "Reads as payment",
          short: "Payment",
          tone: "caution",
          kind: "change",
        });
    }
    if (f.kind === "coinjoin")
      for (const g of f.groups)
        for (const o of g.outputs)
          add(`out:${o}`, {
            text: "Equal amount",
            short: "Equal",
            tone: "neutral",
            kind: "coinjoin",
          });
  }
  return marks;
}

/** A sentence as plain text, addresses shortened as the page shows them, for tests and checks. */
export const plain = (
  s: Sentence,
  short: (a: string) => string = (a) => shownAddress(a).short,
): string =>
  s
    .map((p) => (typeof p === "string" ? p : "address" in p ? short(p.address) : String(p.index)))
    .join("");
