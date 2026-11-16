// What a decoded LNURL or Lightning address points to: one GET from the visitor's browser to the
// service it names (LUD-06 pay, LUD-03 withdraw, LUD-02 channel), never through our server, and
// never the second step (the `callback`, which would ask for an invoice or a withdrawal). Every
// field of the answer is the service's claim: read strictly, shown as text.
import type { Decoded } from "./decode";

/** How long the service has to answer, and the most of its answer read. */
export const ASK_MS = 8000;
export const MAX_ANSWER = 64 * 1024;
/** Free text from the service is cut to this many characters. */
const MAX_TEXT = 1000;

export type Plan =
  /** Ask `url`, whose host is `host`. */
  | { ask: string; host: string }
  /** Shown as decoded, with a line saying it was not asked. */
  | { skip: "not-public" };

/**
 * Whether to ask the service a decoded string names: an LNURL (pay, withdraw, channel or no tag
 * yet) or a Lightning address, over HTTPS to a public name. Never a login link: logging in is an
 * action, not a description. `null` when there is nothing to ask.
 */
export function plan(d: Decoded): Plan | null {
  if (d.kind !== "lnurl" && d.kind !== "lightning_address") return null;
  if (d.kind === "lnurl" && d.tag?.toLowerCase() === "login") return null;
  let url: URL;
  try {
    url = new URL(d.url);
  } catch {
    return { skip: "not-public" };
  }
  // The tag as the service will read it, percent-decoded (`tag=%6cogin` is a login too).
  if (url.searchParams.getAll("tag").some((t) => t.toLowerCase() === "login")) return null;
  const host = url.hostname;
  // A name in public DNS only: no address literal, no local name (a pasted string must not make
  // a visitor's browser ask their own network).
  const named =
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) &&
    !/^[\d.]+$/.test(host) &&
    !/\.(local|localhost|internal|lan|home|onion)$/.test(host) &&
    !/(^|\.)home\.arpa$/.test(host);
  return url.protocol === "https:" && url.username === "" && url.password === "" && named
    ? { ask: url.href, host }
    : { skip: "not-public" };
}

/** Why the service gave nothing to show. */
export class AskError extends Error {
  readonly why: "timeout" | "failed";
  constructor(why: "timeout" | "failed") {
    super(why);
    this.name = "AskError";
    this.why = why;
  }
}

/** The body, read until `max` bytes; more than that is a failure, the rest never read. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel();
      throw new AskError("failed");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * One GET of `url`: no cookies, no referrer, `ASK_MS` to answer whole, `MAX_ANSWER` bytes read,
 * parsed as JSON. Rejects with `AskError`, or with the abort when `signal` ends it.
 */
export async function ask(url: string, signal: AbortSignal, ms = ASK_MS): Promise<unknown> {
  const own = new AbortController();
  let late = false;
  const stop = () => own.abort();
  signal.addEventListener("abort", stop);
  const timer = setTimeout(() => {
    late = true;
    own.abort();
  }, ms);
  try {
    const res = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      // One request: a redirect (to the callback, say) is a failure, never followed.
      redirect: "error",
      signal: own.signal,
    });
    return JSON.parse(await readCapped(res, MAX_ANSWER)) as unknown;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AskError(late ? "timeout" : "failed");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

export type Tag = "payRequest" | "withdrawRequest" | "channelRequest";

/** The service's answer, each field only when present and of the right type. */
export interface Answer {
  /** The service's own refusal (`{"status":"ERROR"}`), its reason as text. */
  error?: string;
  tag?: Tag;
  /** The least and most it takes (pay) or gives (withdraw), in msat. */
  min?: number;
  max?: number;
  description?: string;
  longDescription?: string;
  identifier?: string;
  /** Characters a payer may send with a payment (LUD-12). */
  comment?: number;
  /** The host the second step would go to, and whether it is another than the one asked. */
  callbackHost?: string;
  otherHost?: boolean;
  /** A channel request's node, `<key>@<host>:<port>`. */
  uri?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** The first `MAX_TEXT` characters as a reader counts them, so no emoji is cut in half. */
function cutText(s: string): string {
  let out = "";
  let n = 0;
  for (const { segment } of graphemes.segment(s)) {
    if (n === MAX_TEXT) return `${out}…`;
    out += segment;
    n += 1;
  }
  return out;
}
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? cutText(v) : undefined;
const msat = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const TAGS: ReadonlySet<string> = new Set(["payRequest", "withdrawRequest", "channelRequest"]);

/** LUD-06's metadata: a JSON string of `[type, content]` pairs. */
function metadata(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof v !== "string") return out;
  let pairs: unknown;
  try {
    pairs = JSON.parse(v);
  } catch {
    return out;
  }
  if (!Array.isArray(pairs)) return out;
  for (const p of pairs) {
    if (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" && !out.has(p[0]))
      out.set(p[0], p[1]);
  }
  return out;
}

/** Reads the service's answer to a GET of a URL on `asked`. Anything unreadable is left out. */
export function read(v: unknown, asked: string): Answer {
  if (!isObj(v)) return {};
  if (typeof v["status"] === "string" && v["status"].toUpperCase() === "ERROR") {
    return { error: text(v["reason"]) ?? "no reason given" };
  }
  const out: Answer = {};
  const tag = v["tag"];
  if (typeof tag === "string" && TAGS.has(tag)) out.tag = tag as Tag;
  const [min, max] =
    out.tag === "withdrawRequest"
      ? [msat(v["minWithdrawable"]), msat(v["maxWithdrawable"])]
      : [msat(v["minSendable"]), msat(v["maxSendable"])];
  if (min !== undefined && max !== undefined && min <= max) {
    out.min = min;
    out.max = max;
  }
  const meta = metadata(v["metadata"]);
  const description = text(meta.get("text/plain")) ?? text(v["defaultDescription"]);
  if (description !== undefined) out.description = description;
  const long = text(meta.get("text/long-desc"));
  if (long !== undefined) out.longDescription = long;
  const identifier = text(meta.get("text/identifier")) ?? text(meta.get("text/email"));
  if (identifier !== undefined) out.identifier = identifier;
  const comment = msat(v["commentAllowed"]);
  if (comment !== undefined && comment > 0) out.comment = comment;
  if (typeof v["callback"] === "string") {
    try {
      const cb = new URL(v["callback"]);
      if (cb.protocol === "https:") {
        out.callbackHost = cb.hostname;
        out.otherHost = cb.hostname !== asked;
      }
    } catch {
      // Not a URL: there is no host to show.
    }
  }
  const uri = text(v["uri"]);
  if (out.tag === "channelRequest" && uri !== undefined) out.uri = uri;
  return out;
}

/** What a service says it is, in a word. */
export const TAG_NAMES: Record<Tag, string> = {
  payRequest: "Pay",
  withdrawRequest: "Withdraw",
  channelRequest: "Channel",
};
