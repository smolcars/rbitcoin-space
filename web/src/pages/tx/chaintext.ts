// Text people put on the chain, for the flow cards and the inspector: a coinbase's words, an
// OP_RETURN's data and an ordinals inscription's body. All of it is attacker-controlled: the results
// are plain strings for text nodes, with hidden characters made visible. Never an image: a payload
// that is not text is named by its type and size only.
import type { Transaction, Vin, Vout } from "../../lib/esplora";
import { formatSize, groupDigits } from "../../lib/format";
import { coinbaseTag, type TagPart } from "../block/chain";
import { classify, hexToBytes, isText, type Op, opReturnData, ops, printable } from "./script";

/** Characters of text a card is given; CSS cuts it to its lines, the inspector shows the rest. */
export const CARD_CHARS = 240;

/** Body bytes an inscription keeps to read as text; the rest is counted, never copied. */
export const BODY_KEPT = 128 * 1024;

/** Script steps the envelope reader takes before it gives up: a 400 kB body is about 800 pushes. */
export const ENVELOPE_MAX_OPS = 10_000;

export interface ChainText {
  label: "Coinbase" | "OP_RETURN" | "Inscription";
  /** The text, when there is some: hidden runs (coinbase) are counted, not shown. */
  parts: TagPart[] | null;
  /** What a payload that is not text is: "image/png, 793 B" or "44 bytes". */
  about: string | null;
}

/** An inscription as its envelope declares it. */
export interface Inscription {
  /** Tag 1, as visible text; empty when the envelope names none. */
  contentType: string;
  /** Tag 9 is set: the body is compressed, so it is never read as text here. */
  encoded: boolean;
  /** The whole body's size in bytes. */
  size: number;
  /** The body's first {@link BODY_KEPT} bytes. */
  head: Uint8Array;
}

const OP_0 = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;

/** A field's tag or value as bytes: a push (OP_0 pushes nothing), or OP_1 to OP_16 for one byte. */
function pushed(o: Op): Uint8Array | null {
  if (o.data) return o.data;
  if (o.op === OP_0) return new Uint8Array();
  return o.op >= 0x51 && o.op <= 0x60 ? Uint8Array.of(o.op - 0x50) : null;
}

const isOrd = (d: Uint8Array | undefined) =>
  d?.length === 3 && d[0] === 0x6f && d[1] === 0x72 && d[2] === 0x64;

/**
 * The first ordinals envelope in a tapscript, read from the ordinals documentation: `OP_FALSE OP_IF`,
 * a push of "ord", then pairs of pushes (a tag, then its value) until an empty push, after which
 * every push is the body, closed by `OP_ENDIF`. Tag 1 is the content type and tag 9 the content
 * encoding; other tags are skipped. A script may hold several envelopes; only the first is read.
 * Null when there is none, or when it is broken: a push past the end, an opcode that pushes nothing
 * inside it, or no `OP_ENDIF`. Bounded by {@link ENVELOPE_MAX_OPS} and {@link BODY_KEPT}.
 */
export function envelope(scriptHex: string): Inscription | null {
  let steps = 0;
  // The last two opcodes seen, to spot `OP_FALSE OP_IF "ord"`.
  let before = -1;
  let last = -1;
  const it = ops(hexToBytes(scriptHex));
  for (const o of it) {
    if (++steps > ENVELOPE_MAX_OPS || o.truncated) return null;
    if (before === OP_0 && last === OP_IF && isOrd(o.data)) return fields(it, steps);
    before = last;
    last = o.op;
  }
  return null;
}

/** Reads an envelope from just after its "ord" to its `OP_ENDIF`. */
function fields(it: Iterator<Op>, stepsBefore: number): Inscription | null {
  let steps = stepsBefore;
  let contentType = "";
  let encoded = false;
  let tag: Uint8Array | null = null;
  let inBody = false;
  let size = 0;
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  for (let r = it.next(); r.done !== true; r = it.next()) {
    const o = r.value;
    if (++steps > ENVELOPE_MAX_OPS || o.truncated) return null;
    if (o.op === OP_ENDIF) {
      const head = new Uint8Array(keptBytes);
      let at = 0;
      for (const c of kept) {
        head.set(c, at);
        at += c.length;
      }
      return { contentType, encoded, size, head };
    }
    const d = pushed(o);
    // Only pushes belong in an envelope.
    if (d === null) return null;
    if (inBody) {
      size += d.length;
      if (keptBytes < BODY_KEPT) {
        const piece = d.subarray(0, BODY_KEPT - keptBytes);
        kept.push(piece);
        keptBytes += piece.length;
      }
    } else if (tag === null) {
      // An empty push where a tag would be starts the body.
      if (d.length === 0) inBody = true;
      else tag = d;
    } else {
      // The first of a repeated field counts, as the documentation says.
      if (tag.length === 1 && tag[0] === 1 && contentType === "")
        contentType = printable(d, 100).text;
      if (tag.length === 1 && tag[0] === 9) encoded = true;
      tag = null;
    }
  }
  return null;
}

/**
 * The script a taproot script-path spend reveals: the item before the control block, once an annex
 * (a last item starting 0x50) is set aside. Null for a key-path spend or anything else.
 */
export function tapscript(vin: Vin): string | null {
  if (vin.prevout && classify(vin.prevout.scriptpubkey).kind !== "p2tr") return null;
  const w = vin.witness ?? [];
  const stack = w.length > 1 && w.at(-1)?.startsWith("50") ? w.slice(0, -1) : w;
  const control = stack.at(-1) ?? "";
  // 33 bytes, then 32 per step of the tree path, led by a leaf version byte.
  const n = control.length / 2;
  const leaf = Number.parseInt(control.slice(0, 2), 16);
  if (stack.length < 2 || n < 33 || n > 33 + 32 * 128 || (n - 33) % 32 !== 0) return null;
  return (leaf & 0xfe) === 0xc0 ? (stack.at(-2) ?? null) : null;
}

/** The inscription an input reveals, if any. */
export function inscriptionOf(vin: Vin): Inscription | null {
  const s = tapscript(vin);
  return s === null ? null : envelope(s);
}

/** Text we show: a `text/*` or `application/json` body, not compressed, that reads as text. */
export const isTextInscription = (i: Inscription): boolean =>
  /^\s*(?:text\/[^;\s]*|application\/json)\s*(?:;|$)/i.test(i.contentType) &&
  !i.encoded &&
  isText(i.head);

/** Bytes as one run of visible text, with "…" when they were cut. */
function asParts(bytes: Uint8Array, max: number, more = false): TagPart[] {
  const p = printable(bytes, max);
  return [{ text: p.chars >= max || more ? `${p.text}…` : p.text }];
}

/** A coinbase's words, read as the block page reads its "Coinbase tag". */
export function coinbaseText(tx: Transaction): ChainText | null {
  const vin = tx.vin?.[0];
  if (!vin?.is_coinbase) return null;
  const tag = coinbaseTag(vin.scriptsig, tx.status?.block_height ?? -1);
  return tag?.readable ? { label: "Coinbase", parts: tag.parts, about: null } : null;
}

/** An input's inscription, as text or as what it is. */
export function inputText(vin: Vin, max = CARD_CHARS): ChainText | null {
  const ins = inscriptionOf(vin);
  if (!ins) return null;
  if (isTextInscription(ins))
    return {
      label: "Inscription",
      parts: asParts(ins.head, max, ins.size > ins.head.length),
      about: null,
    };
  return { label: "Inscription", parts: null, about: inscriptionAbout(ins) };
}

/** "image/png, 793 B": what an inscription is, never its content. */
export const inscriptionAbout = (ins: Inscription): string =>
  [ins.contentType || "No content type", formatSize(ins.size, "B")].join(", ");

/** An OP_RETURN output's data, as text or as its size. */
export function outputText(out: Vout, max = CARD_CHARS): ChainText | null {
  if (classify(out.scriptpubkey).kind !== "op_return") return null;
  const data = opReturnData(out.scriptpubkey);
  if (isText(data)) return { label: "OP_RETURN", parts: asParts(data, max), about: null };
  return {
    label: "OP_RETURN",
    parts: null,
    about: data.length > 0 ? `${groupDigits(data.length)} bytes` : null,
  };
}
