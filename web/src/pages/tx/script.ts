// Bitcoin script, read from hex: what kind of script it is, its assembly, and the text it carries.
// Everything here takes attacker-controlled bytes and must never throw on them.

/** Hex string to bytes. Stops at the first character pair that is not hex. */
export function hexToBytes(hex: string): Uint8Array {
  const n = Math.floor(hex.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return out.slice(0, i);
    out[i] = b;
  }
  return out;
}

const toHex = (bytes: Uint8Array, start: number, end: number): string => {
  let s = "";
  for (let i = start; i < end; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return s;
};

// Opcode names from 0x61 up; pushes and small numbers are handled before this table is read.
const NAMES: Record<number, string> = {
  79: "OP_1NEGATE",
  80: "OP_RESERVED",
  97: "OP_NOP",
  98: "OP_VER",
  99: "OP_IF",
  100: "OP_NOTIF",
  101: "OP_VERIF",
  102: "OP_VERNOTIF",
  103: "OP_ELSE",
  104: "OP_ENDIF",
  105: "OP_VERIFY",
  106: "OP_RETURN",
  107: "OP_TOALTSTACK",
  108: "OP_FROMALTSTACK",
  109: "OP_2DROP",
  110: "OP_2DUP",
  111: "OP_3DUP",
  112: "OP_2OVER",
  113: "OP_2ROT",
  114: "OP_2SWAP",
  115: "OP_IFDUP",
  116: "OP_DEPTH",
  117: "OP_DROP",
  118: "OP_DUP",
  119: "OP_NIP",
  120: "OP_OVER",
  121: "OP_PICK",
  122: "OP_ROLL",
  123: "OP_ROT",
  124: "OP_SWAP",
  125: "OP_TUCK",
  126: "OP_CAT",
  127: "OP_SUBSTR",
  128: "OP_LEFT",
  129: "OP_RIGHT",
  130: "OP_SIZE",
  131: "OP_INVERT",
  132: "OP_AND",
  133: "OP_OR",
  134: "OP_XOR",
  135: "OP_EQUAL",
  136: "OP_EQUALVERIFY",
  137: "OP_RESERVED1",
  138: "OP_RESERVED2",
  139: "OP_1ADD",
  140: "OP_1SUB",
  141: "OP_2MUL",
  142: "OP_2DIV",
  143: "OP_NEGATE",
  144: "OP_ABS",
  145: "OP_NOT",
  146: "OP_0NOTEQUAL",
  147: "OP_ADD",
  148: "OP_SUB",
  149: "OP_MUL",
  150: "OP_DIV",
  151: "OP_MOD",
  152: "OP_LSHIFT",
  153: "OP_RSHIFT",
  154: "OP_BOOLAND",
  155: "OP_BOOLOR",
  156: "OP_NUMEQUAL",
  157: "OP_NUMEQUALVERIFY",
  158: "OP_NUMNOTEQUAL",
  159: "OP_LESSTHAN",
  160: "OP_GREATERTHAN",
  161: "OP_LESSTHANOREQUAL",
  162: "OP_GREATERTHANOREQUAL",
  163: "OP_MIN",
  164: "OP_MAX",
  165: "OP_WITHIN",
  166: "OP_RIPEMD160",
  167: "OP_SHA1",
  168: "OP_SHA256",
  169: "OP_HASH160",
  170: "OP_HASH256",
  171: "OP_CODESEPARATOR",
  172: "OP_CHECKSIG",
  173: "OP_CHECKSIGVERIFY",
  174: "OP_CHECKMULTISIG",
  175: "OP_CHECKMULTISIGVERIFY",
  176: "OP_NOP1",
  177: "OP_CHECKLOCKTIMEVERIFY",
  178: "OP_CHECKSEQUENCEVERIFY",
  186: "OP_CHECKSIGADD",
  255: "OP_INVALIDOPCODE",
};

function opName(op: number): string {
  if (op === 0) return "OP_0";
  if (op >= 0x51 && op <= 0x60) return `OP_${op - 0x50}`;
  if (op >= 0xb3 && op <= 0xb9) return `OP_NOP${op - 0xb3 + 4}`;
  return NAMES[op] ?? `OP_UNKNOWN_0x${op.toString(16)}`;
}

/** One step through a script: an opcode, with its data when it pushes. */
export interface Op {
  op: number;
  /** Pushed bytes; undefined for opcodes that push nothing. */
  data?: Uint8Array;
  /** The push claims more bytes than the script has. */
  truncated?: boolean;
}

/** Walks a script. Stops after a push that runs past the end. */
export function* ops(bytes: Uint8Array): Generator<Op> {
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i++] ?? 0;
    let len = -1;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) len = i + 1 <= bytes.length ? (bytes[i] ?? 0) : Number.POSITIVE_INFINITY;
    else if (op === 0x4d)
      len =
        i + 2 <= bytes.length
          ? (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)
          : Number.POSITIVE_INFINITY;
    else if (op === 0x4e)
      len =
        i + 4 <= bytes.length
          ? ((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8) | ((bytes[i + 2] ?? 0) << 16)) +
            (bytes[i + 3] ?? 0) * 2 ** 24
          : Number.POSITIVE_INFINITY;
    if (len < 0) {
      yield { op };
      continue;
    }
    if (op >= 0x4c) i += op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
    if (i + len > bytes.length) {
      yield { op, data: bytes.subarray(Math.min(i, bytes.length)), truncated: true };
      return;
    }
    yield { op, data: bytes.subarray(i, i + len) };
    i += len;
  }
}

const PUSHDATA: Record<number, string> = {
  76: "OP_PUSHDATA1",
  77: "OP_PUSHDATA2",
  78: "OP_PUSHDATA4",
};

/**
 * Assembly: opcodes by name, pushed data as hex. Stops once the text passes `maxChars` and
 * reports `truncated`, so a megabyte script never becomes a megabyte string unasked.
 */
export function disassemble(
  hex: string,
  maxChars = Number.POSITIVE_INFINITY,
): { text: string; truncated: boolean } {
  const bytes = hexToBytes(hex);
  const parts: string[] = [];
  let length = 0;
  for (const o of ops(bytes)) {
    let part: string;
    if (o.data === undefined) part = opName(o.op);
    else {
      const prefix = PUSHDATA[o.op];
      const data = toHex(o.data, 0, o.data.length);
      const shown = [prefix, data, o.truncated ? "[push past end of script]" : ""].filter(Boolean);
      part = shown.length > 0 ? shown.join(" ") : "OP_0";
    }
    parts.push(part);
    length += part.length + 1;
    if (length > maxChars) {
      const text = parts.join(" ");
      return { text: text.slice(0, maxChars), truncated: true };
    }
  }
  return { text: parts.join(" "), truncated: false };
}

export type ScriptKind =
  | "p2pkh"
  | "p2sh"
  | "p2wpkh"
  | "p2wsh"
  | "p2tr"
  | "anchor"
  | "witness-unknown"
  | "p2pk"
  | "multisig"
  | "op_return"
  | "nonstandard";

export interface ScriptClass {
  kind: ScriptKind;
  /** Plain name for people: "P2WPKH", "Pay to anchor", "Bare multisig, 2 of 3". */
  label: string;
}

const isPubkeyPush = (b: Uint8Array, i: number) =>
  (b[i] === 33 && (b[i + 1] === 2 || b[i + 1] === 3)) || (b[i] === 65 && b[i + 1] === 4);

/** What kind of output script this is, from its bytes alone. */
export function classify(hex: string): ScriptClass {
  const b = hexToBytes(hex);
  const n = b.length;
  if (n === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 20 && b[23] === 0x88 && b[24] === 0xac)
    return { kind: "p2pkh", label: "P2PKH" };
  if (n === 23 && b[0] === 0xa9 && b[1] === 20 && b[22] === 0x87)
    return { kind: "p2sh", label: "P2SH" };
  if (n === 22 && b[0] === 0 && b[1] === 20) return { kind: "p2wpkh", label: "P2WPKH" };
  if (n === 34 && b[0] === 0 && b[1] === 32) return { kind: "p2wsh", label: "P2WSH" };
  if (n === 34 && b[0] === 0x51 && b[1] === 32) return { kind: "p2tr", label: "P2TR" };
  if (n === 4 && b[0] === 0x51 && b[1] === 2 && b[2] === 0x4e && b[3] === 0x73)
    return { kind: "anchor", label: "Pay to anchor" };
  // Any other witness program: version byte, then one push of 2 to 40 bytes and nothing else.
  const v = b[0] ?? -1;
  if (n >= 4 && n <= 42 && (v === 0 || (v >= 0x51 && v <= 0x60)) && b[1] === n - 2)
    return { kind: "witness-unknown", label: `Witness v${v === 0 ? 0 : v - 0x50}` };
  if ((n === 35 || n === 67) && isPubkeyPush(b, 0) && b[n - 1] === 0xac)
    return { kind: "p2pk", label: "P2PK" };
  if (n > 0 && b[0] === 0x6a) return { kind: "op_return", label: "OP_RETURN" };
  const multisig = bareMultisig(b);
  if (multisig)
    return { kind: "multisig", label: `Bare multisig, ${multisig[0]} of ${multisig[1]}` };
  return { kind: "nonstandard", label: n === 0 ? "Empty script" : "Non-standard" };
}

/** `OP_m <pubkey>… OP_n OP_CHECKMULTISIG` with n keys: returns [m, n]. */
function bareMultisig(b: Uint8Array): [number, number] | null {
  const m = (b[0] ?? 0) - 0x50;
  if (m < 1 || m > 16 || b.at(-1) !== 0xae) return null;
  let i = 1;
  let keys = 0;
  while (i < b.length - 2 && isPubkeyPush(b, i)) {
    i += (b[i] ?? 0) + 1;
    keys++;
  }
  const n = (b[i] ?? 0) - 0x50;
  return i === b.length - 2 && n === keys && m <= n ? [m, n] : null;
}

/** The bytes an OP_RETURN output carries: every push after OP_RETURN, joined. */
export function opReturnData(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes[0] !== 0x6a) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  for (const o of ops(bytes.subarray(1))) if (o.data) chunks.push(o.data);
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The last push of a script, such as the redeem script at the end of a P2SH scriptSig. */
export function lastPush(hex: string): string | null {
  let last: Uint8Array | null = null;
  for (const o of ops(hexToBytes(hex))) last = o.data && !o.truncated ? o.data : null;
  return last && last.length > 0 ? toHex(last, 0, last.length) : null;
}

// Characters that would hide, reorder or break text: controls, format characters (bidi overrides,
// zero-width), line and paragraph separators. Shown as escapes instead.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface Printable {
  text: string;
  /** Bytes that were not valid UTF-8 or not visible, each shown as an escape. */
  escaped: number;
  /** Characters in `text`, counting each escape as one. */
  chars: number;
}

/**
 * Bytes as visible text: valid UTF-8 shown as is, anything else as `\xNN` (bad bytes) or `\u{…}`
 * (invisible characters). Stops after `maxChars` characters.
 */
export function printable(bytes: Uint8Array, maxChars = Number.POSITIVE_INFINITY): Printable {
  let text = "";
  let escaped = 0;
  let chars = 0;
  let i = 0;
  while (i < bytes.length && chars < maxChars) {
    const [cp, len] = decodeUtf8(bytes, i);
    chars++;
    if (cp === null) {
      text += `\\x${(bytes[i] ?? 0).toString(16).padStart(2, "0")}`;
      escaped++;
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    if (HIDDEN.test(ch) || cp === 0xfffd) {
      text += `\\u{${cp.toString(16)}}`;
      escaped++;
    } else text += ch;
    i += len;
  }
  return { text, escaped, chars };
}

/** One UTF-8 character at `i`: [code point, byte length], or [null, 1] when the bytes are not valid. */
function decodeUtf8(b: Uint8Array, i: number): [number | null, number] {
  const c = b[i] ?? 0;
  if (c < 0x80) return [c, 1];
  const len =
    c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
  if (len === 0 || i + len > b.length) return [null, 1];
  let cp = c & (0xff >> (len + 1));
  for (let k = 1; k < len; k++) {
    const x = b[i + k] ?? 0;
    if ((x & 0xc0) !== 0x80) return [null, 1];
    cp = (cp << 6) | (x & 0x3f);
  }
  const min = [0, 0, 0x80, 0x800, 0x10000][len] ?? 0;
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return [null, 1];
  return [cp, len];
}

/** Whether data reads as text: valid UTF-8, mostly visible. Short binary blobs are not text. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const p = printable(bytes);
  return p.escaped <= p.chars * 0.2 && p.chars - p.escaped >= Math.min(4, bytes.length);
}
