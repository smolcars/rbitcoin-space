// Checking an OpenTimestamps proof (docs/FRONTEND.md "Timestamp proofs"). The reader's file is
// hashed here and never leaves the page; neither does its digest. The only requests a proof causes
// are for the blocks its Bitcoin attestations name, to this server's mainnet: the hash at a height
// and that block's header. Everything read from the proof is shown as text, a calendar's address
// included, which is never a link.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { ErrorState, Loading } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import { ApiError, createRequest, fetchApi } from "../../lib/api";
import { loadConfig, readConfig } from "../../lib/config";
import { formatSize, groupDigits, truncateMiddle } from "../../lib/format";
import { NETWORK_NAMES, paths } from "../../lib/network";
import { NetworkScope, useNetwork, usePageTitle } from "../../lib/page";
import { CHUNK, HASH_NAMES, hashFile, readDigest } from "./digest";
import { DIGEST_LENGTH, type HashName, reversed, toHex } from "./hashes";
import { type Leaf, LIMITS, type Op, parseProof, type Proof, ProofError } from "./ots";
import {
  attestationName,
  type Block,
  blockFetcher,
  type Check,
  MAX_CHECKS,
  headerTimeRule,
  steps,
  type Verdict,
  verify,
} from "./verify";
import "./Timestamp.css";

type ProofInput =
  | { name: string; size: number; proof: Proof }
  | { name: string; size: number; error: ProofError }
  /** Chosen, its bytes still being read. */
  | { name: string; size: number; reading: true }
  /** The browser could not read its bytes: nothing was parsed. */
  | { name: string; size: number; unreadable: true };

type Hashing =
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; file: File; name: HashName; digest: Uint8Array }
  | { kind: "cancelled" }
  | { kind: "failed" };

/** A block by height from this server's mainnet: its hash, then its header, checked against it. */
const fetchBlock = blockFetcher((path, signal) =>
  fetchApi<string>("mainnet", path, { as: "text", signal }),
);

/** Where the digest came from: a file the page hashed, or hex the reader gave. */
type From = "file" | "digest";

/** A verdict with what it was reached for. */
interface Answer {
  v: Verdict;
  p: Proof;
  d: Uint8Array;
  from: From;
}

async function readProofFile(file: File): Promise<ProofInput> {
  const base = { name: file.name, size: file.size };
  if (file.size > LIMITS.proofBytes)
    return {
      ...base,
      error: new ProofError("too-large", "This file is far larger than any timestamp proof."),
    };
  try {
    return { ...base, proof: parseProof(new Uint8Array(await file.arrayBuffer())) };
  } catch (e) {
    if (e instanceof ProofError) return { ...base, error: e };
    return { ...base, unreadable: true };
  }
}

export default function TimestampPage() {
  usePageTitle(() => "Check a timestamp");
  const network = useNetwork();
  const [proofIn, setProofIn] = createSignal<ProofInput | undefined>(undefined);
  const [file, setFile] = createSignal<File | undefined>(undefined);
  const [hex, setHex] = createSignal("");
  const [hashing, setHashing] = createSignal<Hashing | undefined>(undefined);
  let cancel: (() => void) | undefined;
  // Each read and each hash answers only for the choice that started it: a later choice or a
  // removal makes it moot, whenever it finishes.
  let proofPick = 0;
  let job: AbortController | undefined;

  const proof = (): Proof | undefined => {
    const p = proofIn();
    return p && "proof" in p ? p.proof : undefined;
  };
  const proofError = (): ProofError | undefined => {
    const p = proofIn();
    return p && "error" in p ? p.error : undefined;
  };
  const reading = (): boolean => {
    const p = proofIn();
    return p !== undefined && "reading" in p;
  };
  const unreadable = (): boolean => {
    const p = proofIn();
    return p !== undefined && "unreadable" in p;
  };
  // A memo, so a proof replaced by one that wants the same hash does not hash the file again.
  const algorithm = createMemo((): HashName => proof()?.fileHash ?? "sha256");
  const running = () => {
    const h = hashing();
    return h?.kind === "running" ? h : undefined;
  };

  // The file is hashed with the proof's own hash, again if a proof that names another arrives.
  createEffect(
    () => ({ f: file(), name: algorithm() }),
    ({ f, name }) => {
      if (!f) {
        job = undefined;
        setHashing(undefined);
        return undefined;
      }
      const controller = new AbortController();
      job = controller;
      cancel = () => controller.abort();
      const current = () => job === controller;
      setHashing({ kind: "running", done: 0, total: f.size });
      hashFile(
        f,
        name,
        (done) => {
          if (current() && !controller.signal.aborted)
            setHashing({ kind: "running", done, total: f.size });
        },
        controller.signal,
      ).then(
        (digest) => {
          if (current() && !controller.signal.aborted)
            setHashing({ kind: "done", file: f, name, digest });
        },
        () => {
          // Only the reader's Stop ends the current job early; a replaced job ends unseen.
          if (current())
            setHashing(controller.signal.aborted ? { kind: "cancelled" } : { kind: "failed" });
        },
      );
      return () => controller.abort();
    },
  );
  onCleanup(() => cancel?.());

  const digest = (): Uint8Array | undefined => {
    const h = hashing();
    const f = file();
    if (f)
      return h?.kind === "done" && h.file === f && h.name === algorithm() ? h.digest : undefined;
    return readDigest(hex(), algorithm()) ?? undefined;
  };
  const hexProblem = (): string | undefined => {
    const t = hex().replaceAll(/\s/g, "");
    if (file() || t === "" || readDigest(t, algorithm())) return undefined;
    const want = DIGEST_LENGTH[algorithm()] * 2;
    if (!/^[0-9a-fA-F]*$/.test(t))
      return `A ${HASH_NAMES[algorithm()]} digest is written in hex: 0 to 9 and a to f.`;
    return `A ${HASH_NAMES[algorithm()]} digest is ${want} hex digits; this is ${t.length}.`;
  };

  const [verdict, { refetch }] = createRequest(
    () => {
      const p = proof();
      const d = digest();
      const from: From = file() ? "file" : "digest";
      return p && d ? { p, d, from } : false;
    },
    async ({ p, d, from }, signal): Promise<Answer> => {
      const config = (await loadConfig()) ?? (await readConfig());
      if (config === null) throw new ApiError(0, "The server's networks could not be read.");
      const mainnet = config.networks.includes("mainnet");
      return { v: await verify(p, d, { mainnet, fetchBlock, signal }), p, d, from };
    },
  );
  /** Whether a verdict is for what is chosen now: the same proof, digest and source. */
  const current = (a: Answer | undefined): a is Answer => {
    const d = digest();
    return (
      a !== undefined &&
      d !== undefined &&
      a.p === proof() &&
      toHex(a.d) === toHex(d) &&
      a.from === (file() ? "file" : "digest")
    );
  };

  const chooseProof = (f: File | undefined) => {
    if (!f) return;
    const pick = ++proofPick;
    // The last proof and its verdict go at once: never a verdict beside a choice it is not for.
    setProofIn({ name: f.name, size: f.size, reading: true });
    void readProofFile(f).then((p) => {
      if (pick === proofPick) setProofIn(p);
    });
  };
  const chooseFile = (f: File | undefined) => {
    if (!f) return;
    setHex("");
    setFile(f);
  };

  return (
    <div class="wrap ots">
      <h1>Check a timestamp</h1>
      <p class="ots__lede">
        An OpenTimestamps proof shows that a file existed before a certain Bitcoin block: it is a
        short chain of hashes from the file to a value written into that block. Give this page the
        proof and the file, and it follows the chain to the block on this server's own node.
      </p>
      <p class="ots__lede ots__lede--quiet">
        Your file is read in your browser and never sent anywhere. The page asks this server only
        for the block the proof names.
        <Show when={network() !== "mainnet"}>
          {" "}
          Bitcoin timestamps live on mainnet, so the block is looked up there, not on{" "}
          {NETWORK_NAMES[network()]}.
        </Show>
      </p>

      <div class="ots-inputs">
        <Slot
          title="Proof"
          hint="The .ots file"
          accept=".ots,application/octet-stream,application/vnd.opentimestamps.v1"
          chosen={proofIn()?.name}
          detail={proofIn() && formatSize(proofIn()?.size ?? 0, "B")}
          onChoose={chooseProof}
          onClear={() => {
            proofPick++;
            setProofIn(undefined);
          }}
          clearLabel="Remove the proof"
        />
        <Slot
          title="Your file"
          hint={`Hashed here with ${HASH_NAMES[algorithm()]}, never uploaded`}
          chosen={file()?.name}
          detail={file() && formatSize(file()?.size ?? 0, "B")}
          onChoose={chooseFile}
          onClear={() => {
            cancel?.();
            setFile(undefined);
          }}
          clearLabel="Remove the file"
          filled={readDigest(hex(), algorithm()) !== null}
        >
          <Show when={running()}>
            {(h) => <Progress done={h().done} total={h().total} onCancel={() => cancel?.()} />}
          </Show>
          <Show when={hashing()?.kind === "cancelled"}>
            <p class="ots-slot__note">Hashing stopped. Choose the file again to start over.</p>
          </Show>
          <Show when={!file()}>
            <label class="ots-hex">
              <span class="ots-hex__label">Or its {HASH_NAMES[algorithm()]}, in hex</span>
              <input
                class="ots-hex__input mono"
                type="text"
                name="digest"
                autocomplete="off"
                spellcheck={false}
                autocapitalize="off"
                aria-invalid={hexProblem() ? "true" : "false"}
                aria-describedby="ots-hex-problem"
                value={hex()}
                onInput={(e) => setHex(e.currentTarget.value)}
              />
              <span id="ots-hex-problem" class="ots-slot__note ots-slot__note--bad">
                {hexProblem() ?? ""}
              </span>
            </label>
          </Show>
        </Slot>
      </div>

      <section class="ots-result" aria-label="Result">
        <Switch>
          <Match when={proofError()}>{(e) => <NotAProof error={e()} />}</Match>
          <Match when={unreadable()}>
            <Unreadable what="proof" />
          </Match>
          <Match when={file() && hashing()?.kind === "failed"}>
            <Unreadable what="file" />
          </Match>
          <Match when={reading()}>
            <Loading label="Reading the proof" />
          </Match>
          <Match when={!proof() || !digest()}>
            <Waiting proof={proof() !== undefined} digest={digest() !== undefined} />
          </Match>
          <Match when={verdict.state === "errored" && !(verdict.error instanceof ProofError)}>
            <ErrorState title="Could not check the block" error={verdict.error} retry={refetch} />
          </Match>
          <Match when={verdict.state === "errored"}>
            <NotAProof error={verdict.error as ProofError} />
          </Match>
          <Match when={verdict.loading || !current(verdict.latest)}>
            <Loading label="Checking the block" />
          </Match>
          <Match when={verdict.latest}>
            {(r) => <Result v={r().v} digest={r().d} from={r().from} proof={proof()} />}
          </Match>
        </Switch>
      </section>
    </div>
  );
}

/** A drop zone with a file input: what is chosen, and anything else the slot holds below it. */
function Slot(props: {
  title: string;
  hint: string;
  accept?: string;
  chosen: string | undefined;
  detail: string | undefined;
  onChoose: (f: File | undefined) => void;
  onClear: () => void;
  clearLabel: string;
  /** Holds what it needs another way (a digest typed in): drawn as settled. */
  filled?: boolean;
  children?: JSX.Element;
}) {
  const [over, setOver] = createSignal(false);
  let input: HTMLInputElement | undefined;
  return (
    <div
      class={[
        "ots-slot",
        {
          "ots-slot--over": over(),
          "ots-slot--full": props.chosen !== undefined || props.filled === true,
        },
      ]}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        props.onChoose(e.dataTransfer?.files[0]);
      }}
    >
      <h2 class="ots-slot__title">{props.title}</h2>
      <p class="ots-slot__hint">{props.hint}</p>
      <div class="ots-slot__pick">
        <label class="btn ots-slot__choose">
          {props.chosen === undefined ? "Choose a file" : "Choose another"}
          <input
            ref={input}
            class="visually-hidden"
            type="file"
            {...(props.accept ? { accept: props.accept } : {})}
            onChange={(e) => {
              props.onChoose(e.currentTarget.files?.[0]);
              // The same file chosen again is a new choice.
              e.currentTarget.value = "";
            }}
          />
        </label>
        <span class="ots-slot__drop muted">or drop it here</span>
      </div>
      <Show when={props.chosen}>
        {(name) => (
          <p class="ots-slot__chosen">
            <bdi class="ots-slot__name">{name()}</bdi>
            <span class="muted num">{props.detail}</span>
            <button
              class="ots-slot__clear tap"
              type="button"
              aria-label={props.clearLabel}
              onClick={() => {
                props.onClear();
                input?.focus();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </p>
        )}
      </Show>
      {props.children}
    </div>
  );
}

function Progress(props: { done: number; total: number; onCancel: () => void }) {
  const percent = () => (props.total === 0 ? 100 : Math.floor((props.done / props.total) * 100));
  return (
    <div class="ots-progress">
      <progress
        class="ots-progress__bar"
        max={Math.max(props.total, 1)}
        value={props.done}
        aria-label="Hashing your file"
      />
      <span class="ots-progress__text muted num">
        Hashing, {percent()}% of {formatSize(props.total, "B")}
      </span>
      <Show when={props.total > CHUNK}>
        <button class="btn ots-progress__cancel" type="button" onClick={() => props.onCancel()}>
          Stop
        </button>
      </Show>
    </div>
  );
}

function Waiting(props: { proof: boolean; digest: boolean }) {
  return (
    <p class="ots-waiting muted">
      {props.proof
        ? "Now the file the proof is for, or its digest."
        : props.digest
          ? "Now the proof."
          : "Give the page a proof and the file it timestamps."}
    </p>
  );
}

const MESSAGES: Record<ProofError["kind"], string> = {
  "not-proof": "This is not a timestamp proof",
  truncated: "This proof is cut short",
  version: "This proof's version is not supported",
  "unknown-op": "This proof uses an operation this page does not support",
  "too-large": "This proof is larger than this page reads",
  malformed: "This proof breaks the format",
};

/** A file the browser could not read: nothing in it reached the page. */
function Unreadable(props: { what: "proof" | "file" }) {
  return (
    <Verdictbox
      tone="negative"
      status="Not read"
      title={
        props.what === "proof" ? "The proof file could not be read" : "Your file could not be read"
      }
    >
      <p>
        The browser could not read {props.what === "proof" ? "the proof file" : "your file"}, so
        nothing in it was checked. Choose it again, or check that it is still there and readable.
      </p>
    </Verdictbox>
  );
}

function NotAProof(props: { error: ProofError }) {
  return (
    <Verdictbox tone="negative" status="Not checked" title={MESSAGES[props.error.kind]}>
      <p>{props.error.message}</p>
      <p class="muted">
        {props.error.kind === "not-proof"
          ? "A proof is the small .ots file made beside the file it timestamps, often named after it."
          : props.error.kind === "truncated"
            ? "It may have been cut off while being copied or downloaded. Try the original file."
            : "Nothing was checked against a block."}
      </p>
    </Verdictbox>
  );
}

const ICONS = {
  positive: "M3.5 8.5l3 3 6-7",
  negative: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  caution: "M8 4.5v4M8 11v.5",
} as const;

/** The verdict's frame: a status in an icon and a word, the answer as a heading, the rest below. */
function Verdictbox(props: {
  tone: "positive" | "negative" | "caution";
  status: string;
  title: JSX.Element;
  children?: JSX.Element;
}) {
  return (
    <article class={`ots-verdict ots-verdict--${props.tone}`} aria-labelledby="ots-verdict-title">
      <p class="ots-verdict__status" role="status">
        <svg class="ots-verdict__icon" viewBox="0 0 16 16" aria-hidden="true">
          <Show when={props.tone === "caution"} fallback={<circle cx="8" cy="8" r="6.5" />}>
            <circle cx="8" cy="8" r="6.5" stroke-dasharray="2.6 1.9" />
          </Show>
          <path d={ICONS[props.tone]} />
        </svg>
        {props.status}
      </p>
      <h2 id="ots-verdict-title" class="ots-verdict__title">
        {props.title}
      </h2>
      <div class="ots-verdict__body">{props.children}</div>
    </article>
  );
}

/** The reader's input as the verdict names it. */
const GIVEN: Record<From, string> = { file: "your file", digest: "the digest you gave" };

/** Heights, as a list in words: "100, 101 and 102". */
function heightList(checks: readonly Check[]): string {
  const hs = [...new Set(checks.map((c) => groupDigits(c.height)))];
  return hs.length < 2 ? (hs[0] ?? "") : `${hs.slice(0, -1).join(", ")} and ${hs.at(-1) ?? ""}`;
}

function Result(props: { v: Verdict; digest: Uint8Array; from: From; proof: Proof | undefined }) {
  const name = () => HASH_NAMES[props.proof?.fileHash ?? "sha256"];
  return (
    <NetworkScope value="mainnet">
      <Switch>
        <Match when={props.v.kind === "verified" && props.v}>
          {(v) => <Verified v={v()} digest={props.digest} from={props.from} proof={props.proof} />}
        </Match>
        <Match when={props.v.kind === "wrong-file" && props.v}>
          {(v) => (
            <Show
              when={props.from === "file"}
              fallback={
                <Verdictbox
                  tone="negative"
                  status="Different digest"
                  title="The digest you gave is not the one this proof starts from"
                >
                  <p>
                    This proof starts from another {name()}. Check that you copied the digest of the
                    right file, and all of it.
                  </p>
                  <dl class="ots-pair">
                    <dt>The digest you gave</dt>
                    <dd class="mono ots-hex-value">{toHex(v().fileDigest)}</dd>
                    <dt>The digest the proof starts from</dt>
                    <dd class="mono ots-hex-value">{toHex(v().proofDigest)}</dd>
                  </dl>
                </Verdictbox>
              }
            >
              <Verdictbox
                tone="negative"
                status="Different file"
                title="This proof is not for this file"
              >
                <p>
                  The proof starts from a {name()} that is not your file's. A single changed byte,
                  another line ending or a re-saved copy can give a file another digest.
                </p>
                <dl class="ots-pair">
                  <dt>Your file's {name()}</dt>
                  <dd class="mono ots-hex-value">{toHex(v().fileDigest)}</dd>
                  <dt>The digest the proof starts from</dt>
                  <dd class="mono ots-hex-value">{toHex(v().proofDigest)}</dd>
                </dl>
              </Verdictbox>
            </Show>
          )}
        </Match>
        <Match when={props.v.kind === "broken" && props.v}>
          {(v) => {
            const bad = () =>
              v().checks.find((c): c is Check & { kind: "mismatch" } => c.kind === "mismatch");
            return (
              <Verdictbox
                tone="negative"
                status="Does not verify"
                title={`This proof does not lead to block ${groupDigits(bad()?.height ?? 0)}`}
              >
                <p>
                  Following the proof's steps from {GIVEN[props.from]} ends in a value that is not
                  the merkle root of the block this server's node has at that height, and no other
                  Bitcoin attestation in the proof does better. Either the proof is damaged or made
                  up, or it refers to a different block at that height than the one this node has.
                </p>
                <Show when={bad()}>
                  {(c) => (
                    <dl class="ots-pair">
                      <dt>The proof's steps end in</dt>
                      <dd class="mono ots-hex-value">{toHex(c().leaf.message)}</dd>
                      <dt>
                        <Link href={paths.block(c().block.hash)}>
                          Block {groupDigits(c().height)}
                        </Link>
                        's merkle root
                      </dt>
                      <dd class="mono ots-hex-value">{toHex(c().block.merkleRoot)}</dd>
                    </dl>
                  )}
                </Show>
                <Also checks={v().checks} others={v().others} except={bad()} />
                <Show when={bad()}>
                  {(c) => (
                    <Work
                      digest={props.digest}
                      from={props.from}
                      leaf={c().leaf}
                      block={c().block}
                      verified={false}
                    />
                  )}
                </Show>
              </Verdictbox>
            );
          }}
        </Match>
        <Match when={props.v.kind === "incomplete" && props.v}>
          {(v) => {
            const of = (kind: Check["kind"]) => v().checks.filter((c) => c.kind === kind);
            return (
              <Verdictbox
                tone="caution"
                status="Not fully checked"
                title="This proof could not be fully checked"
              >
                <p>
                  No path checked here reaches its block's merkle root, but not every Bitcoin
                  attestation in the proof could be checked, so this says nothing about the proof as
                  a whole.
                </p>
                <ul class="ots-list">
                  <Show when={of("mismatch").length > 0}>
                    <li>
                      Did not reach the merkle root: block{of("mismatch").length > 1 ? "s" : ""}{" "}
                      {heightList(of("mismatch"))}
                    </li>
                  </Show>
                  <Show when={of("skipped").length > 0}>
                    <li>
                      Not checked, past the {MAX_CHECKS} blocks this page asks about: block
                      {of("skipped").length > 1 ? "s" : ""} {heightList(of("skipped"))}
                    </li>
                  </Show>
                  <Show when={of("failed").length > 0}>
                    <li>
                      Could not be checked, the request failed: block
                      {of("failed").length > 1 ? "s" : ""} {heightList(of("failed"))}
                    </li>
                  </Show>
                  <Show when={of("missing").length > 0}>
                    <li>
                      Not known to this node: block{of("missing").length > 1 ? "s" : ""}{" "}
                      {heightList(of("missing"))}
                    </li>
                  </Show>
                </ul>
                <Also checks={[]} others={v().others} />
              </Verdictbox>
            );
          }}
        </Match>
        <Match when={props.v.kind === "unknown-block" && props.v}>
          {(v) => (
            <Verdictbox
              tone="caution"
              status="Not checked"
              title={`This node has no block ${groupDigits(v().checks[0]?.height ?? 0)}`}
            >
              <p>
                This server's node has no block at the height the proof names: its chain does not
                reach that height. Nothing here says the proof is wrong; check it again later, or on
                another node.
              </p>
              <Also checks={v().checks} others={v().others} except={v().checks[0]} />
            </Verdictbox>
          )}
        </Match>
        <Match when={props.v.kind === "pending" && props.v}>
          {(v) => (
            <Verdictbox tone="caution" status="Pending" title="Not verified yet">
              <p>
                This proof has{" "}
                {v().calendars.length === 1
                  ? "a pending calendar attestation"
                  : "pending calendar attestations"}{" "}
                and no Bitcoin attestation, so there is no block to check.
              </p>
              <p>
                Upgrade it with your OpenTimestamps client (<code class="mono">ots upgrade</code>{" "}
                and the proof's file name) once a calendar has put it into a block, often a few
                hours after the proof was made, then check the upgraded proof here.
              </p>
              <h3 class="ots-sub">Calendars that promised it</h3>
              <ul class="ots-list">
                <For each={v().calendars}>
                  {/* Chosen by whoever made the proof: text, never a link. */}
                  {(uri) => <li class="mono ots-uri">{uri}</li>}
                </For>
              </ul>
              <Also
                checks={[]}
                others={v().others.filter((l) => l.attestation.kind !== "pending")}
              />
            </Verdictbox>
          )}
        </Match>
        <Match when={props.v.kind === "no-bitcoin" && props.v}>
          {(v) => (
            <Verdictbox
              tone="caution"
              status="Not checked"
              title="This proof has no Bitcoin attestation"
            >
              <p>
                It is attested only by notaries this page does not check. Nothing here says it is
                wrong.
              </p>
              <Also checks={[]} others={v().others} />
            </Verdictbox>
          )}
        </Match>
        <Match when={props.v.kind === "no-mainnet" && props.v}>
          {(v) => (
            <Verdictbox
              tone="caution"
              status="Not checked"
              title="This server does not follow Bitcoin's main chain"
            >
              <p>
                The proof's Bitcoin attestations name block{v().heights.length === 1 ? "" : "s"}{" "}
                {v()
                  .heights.map((h) => groupDigits(h))
                  .join(", ")}
                , and this server has no mainnet node to look{" "}
                {v().heights.length === 1 ? "it" : "them"} up on. The start of the proof matches{" "}
                {GIVEN[props.from]}; check the block on an explorer or a node that follows mainnet.
              </p>
            </Verdictbox>
          )}
        </Match>
      </Switch>
    </NetworkScope>
  );
}

function Verified(props: {
  v: Verdict & { kind: "verified" };
  digest: Uint8Array;
  from: From;
  proof: Proof | undefined;
}) {
  const c = () => props.v.check;
  const name = () => HASH_NAMES[props.proof?.fileHash ?? "sha256"];
  const block = () => (
    <Link class="ots-verdict__block" href={paths.block(c().block.hash)}>
      block <span class="num">{groupDigits(c().height)}</span>
    </Link>
  );
  return (
    <Verdictbox
      tone="positive"
      status="Verified"
      title={
        props.from === "file" ? (
          <>This file existed before {block()}</>
        ) : (
          <>This digest is committed to by {block()}</>
        )
      }
    >
      <Show
        when={props.from === "file"}
        fallback={
          <p>
            Whatever has this {name()} existed before block {groupDigits(c().height)}. This page has
            not seen a file: it checked only the digest you gave, and cannot say which file that is.
          </p>
        }
      >
        <p>
          This proves the file existed by the time block {groupDigits(c().height)} was mined. It
          does not say who made the file or who held it, and it does not say the file was new then:
          it may be older.
        </p>
      </Show>
      <p class="ots-when">
        Block {groupDigits(c().height)}'s header time is <TimeUtc time={c().block.time} />,{" "}
        <TimeAgo time={c().block.time} />.
      </p>
      <p>That time is the miner's claim. {headerTimeRule(c().height)}</p>
      <Show when={props.proof?.fileHash === "sha1"}>
        <p class="ots-caveat">
          This proof names the file by its SHA-1, and two different files can be made to share a
          SHA-1: it holds for every file with this SHA-1, not for one of them alone.
        </p>
      </Show>
      <Show
        when={props.proof?.fileHash !== "sha1" && c().leaf.path.some((op) => op.kind === "sha1")}
      >
        <p class="ots-caveat">
          A step inside the proof uses SHA-1, whose collisions can be made: two different values at
          that step could give the same next value. The file's own digest is {name()}, not SHA-1.
        </p>
      </Show>
      <Also checks={props.v.checks} others={props.v.others} except={c()} />
      <Work
        digest={props.digest}
        from={props.from}
        leaf={c().leaf}
        block={c().block}
        verified={true}
      />
    </Verdictbox>
  );
}

/** The proof's other attestations: other Bitcoin blocks as checked, the rest named as not checked. */
function Also(props: { checks: Check[]; others: Leaf[]; except?: Check | undefined }) {
  const rest = () => props.checks.filter((c) => c !== props.except);
  const skipped = () => props.checks.some((c) => c.kind === "skipped");
  return (
    <Show when={rest().length > 0 || props.others.length > 0}>
      <h3 class="ots-sub">Also in this proof</h3>
      <ul class="ots-list">
        <For each={rest()}>
          {(c) => (
            <li>
              Bitcoin block {groupDigits(c.height)}:{" "}
              {c.kind === "verified" ? (
                <span class="ots-good">also verified</span>
              ) : c.kind === "mismatch" ? (
                <span class="ots-bad">does not lead to its merkle root</span>
              ) : c.kind === "failed" ? (
                <span>
                  could not be checked
                  {c.error instanceof ApiError ? `: ${c.error.message}` : ""}
                </span>
              ) : c.kind === "skipped" ? (
                <span class="muted">not checked</span>
              ) : (
                <span>not known to this node</span>
              )}
            </li>
          )}
        </For>
        <For each={props.others}>
          {(l) => (
            <li>
              {attestationName(l.attestation)}
              {l.attestation.kind === "litecoin" ? ` ${groupDigits(l.attestation.height)}` : ""}
              {l.attestation.kind === "pending" ? (
                <>
                  {" at "}
                  <span class="mono ots-uri">{l.attestation.uri}</span>
                </>
              ) : l.attestation.kind === "unknown" ? (
                <>
                  {" "}
                  <span class="mono">({l.attestation.tag})</span>
                </>
              ) : null}
              : <span class="muted">not checked</span>
            </li>
          )}
        </For>
      </ul>
      <Show when={skipped()}>
        <p class="muted">This page asks about at most {MAX_CHECKS} blocks of one proof.</p>
      </Show>
    </Show>
  );
}

const OP_NAMES: Record<Op["kind"], string> = {
  sha256: "SHA-256",
  sha1: "SHA-1",
  ripemd160: "RIPEMD-160",
  keccak256: "Keccak-256",
  append: "Append",
  prepend: "Prepend",
  reverse: "Reverse",
  hexlify: "Write as hex",
};

const argOf = (op: Op): Uint8Array | undefined =>
  op.kind === "append" || op.kind === "prepend" ? op.arg : undefined;

/** The path from the digest to the block, step by step, behind a disclosure. */
function Work(props: {
  digest: Uint8Array;
  from: From;
  leaf: Leaf;
  block: Block;
  /** Only a verified path's steps are named as a transaction and a merkle branch. */
  verified: boolean;
}) {
  const reaches = () => toHex(props.leaf.message) === toHex(props.block.merkleRoot);
  const list = () => steps(props.digest, props.leaf, props.verified);
  const display = () => toHex(reversed(props.block.merkleRoot));
  return (
    <More
      label={`Show the ${list().length} steps from ${props.from === "file" ? "your file" : "the digest"} to the block`}
    >
      <p>
        Each step works on the value before it: a hash, or bytes added before or after it. The
        values are shortened; hover or long-press one for all of it.
      </p>
      <ol class="ots-steps">
        <li class="ots-step ots-step--end">
          <span class="ots-step__op">
            {props.from === "file" ? "Your file's digest" : "The digest you gave"}
          </span>
          <span class="ots-step__value mono" title={toHex(props.digest)}>
            {truncateMiddle(toHex(props.digest))}
          </span>
        </li>
        <For each={list()}>
          {(s) => (
            <>
              <Show when={s.branch}>
                {(n) => (
                  <li class="ots-step ots-step--mark">
                    From here the steps have the form of the climb up block{" "}
                    {groupDigits(props.block.height)}'s merkle tree, {n()}{" "}
                    {n() === 1 ? "level" : "levels"}: at each, a sibling joined on its side and the
                    pair hashed twice with SHA-256
                  </li>
                )}
              </Show>
              <li class="ots-step">
                <span class="ots-step__op">
                  {s.level
                    ? s.op.kind === "prepend"
                      ? "Sibling on the left"
                      : "Sibling on the right"
                    : OP_NAMES[s.op.kind]}
                  <Show when={argOf(s.op)}>
                    {(arg) => (
                      <>
                        {" "}
                        <span class="ots-step__arg mono" title={toHex(arg())}>
                          {truncateMiddle(toHex(arg()))}
                        </span>
                      </>
                    )}
                  </Show>
                </span>
                <span class="ots-step__value mono" title={toHex(s.result)}>
                  {truncateMiddle(toHex(s.result))}
                </span>
                <Show when={s.txid}>
                  {(txid) => (
                    <span class="ots-step__note">
                      This value has the form of a transaction id:{" "}
                      <Link class="mono" href={paths.tx(txid())}>
                        {truncateMiddle(txid())}
                      </Link>
                    </span>
                  )}
                </Show>
              </li>
            </>
          )}
        </For>
        <li class="ots-step ots-step--end">
          <span class="ots-step__op">
            {reaches()
              ? `The last value is block ${groupDigits(props.block.height)}'s merkle root, as its header stores it`
              : `Block ${groupDigits(props.block.height)}'s merkle root, as its header stores it: not the last value`}
          </span>
          <span class="ots-step__value mono" title={toHex(props.block.merkleRoot)}>
            {truncateMiddle(toHex(props.block.merkleRoot))}
          </span>
          <span class="ots-step__note">
            Explorers print it the other way round:{" "}
            <span class="mono" title={display()}>
              {truncateMiddle(display())}
            </span>
          </span>
        </li>
      </ol>
    </More>
  );
}
