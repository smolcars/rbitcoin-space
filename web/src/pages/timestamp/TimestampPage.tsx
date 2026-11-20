// Checking an OpenTimestamps proof (docs/FRONTEND.md "Timestamp proofs"). The reader's file is
// hashed here and never leaves the page; neither does its digest. The only requests a proof causes
// are for the blocks its Bitcoin attestations name, to this server's mainnet: the hash at a height
// and that block's header. Everything read from the proof is shown as text, a calendar's address
// included, which is never a link.
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Link } from "../../components/Link";
import { More } from "../../components/More";
import { ErrorState, Loading } from "../../components/States";
import { TimeAgo, TimeUtc } from "../../components/Time";
import { ApiError, createRequest, fetchApi, isNotFound } from "../../lib/api";
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
  type Check,
  MAX_CHECKS,
  readHeader,
  steps,
  type Verdict,
  verify,
} from "./verify";
import "./Timestamp.css";

type ProofInput =
  | { name: string; size: number; proof: Proof }
  | { name: string; size: number; error: ProofError };

type Hashing =
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; file: File; name: HashName; digest: Uint8Array }
  | { kind: "cancelled" }
  | { kind: "failed" };

/** A block by height from this server's mainnet: its hash, then its header, checked against it. */
async function fetchBlock(height: number, signal: AbortSignal): Promise<Block | null> {
  let blockHash: string;
  try {
    blockHash = await fetchApi<string>("mainnet", `/block-height/${height}`, {
      as: "text",
      signal,
    });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  const header = await fetchApi<string>("mainnet", `/block/${blockHash}/header`, {
    as: "text",
    signal,
  });
  const block = readHeader(height, blockHash, header);
  if (!block)
    throw new ApiError(0, `The node's answer for block ${groupDigits(height)} could not be read.`);
  return block;
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
    return { ...base, error: new ProofError("malformed", "This file could not be read.") };
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

  const proof = (): Proof | undefined => {
    const p = proofIn();
    return p && "proof" in p ? p.proof : undefined;
  };
  const proofError = (): ProofError | undefined => {
    const p = proofIn();
    return p && "error" in p ? p.error : undefined;
  };
  const algorithm = (): HashName => proof()?.fileHash ?? "sha256";
  const running = () => {
    const h = hashing();
    return h?.kind === "running" ? h : undefined;
  };

  // The file is hashed with the proof's own hash, again if a proof that names another arrives.
  createEffect(
    () => ({ f: file(), name: algorithm() }),
    ({ f, name }) => {
      if (!f) {
        setHashing(undefined);
        return undefined;
      }
      const controller = new AbortController();
      cancel = () => controller.abort();
      setHashing({ kind: "running", done: 0, total: f.size });
      hashFile(
        f,
        name,
        (done) => {
          if (!controller.signal.aborted) setHashing({ kind: "running", done, total: f.size });
        },
        controller.signal,
      ).then(
        (digest) => {
          if (!controller.signal.aborted) setHashing({ kind: "done", file: f, name, digest });
        },
        () => setHashing(controller.signal.aborted ? { kind: "cancelled" } : { kind: "failed" }),
      );
      return () => controller.abort();
    },
  );
  onCleanup(() => cancel?.());

  const digest = (): Uint8Array | undefined => {
    const h = hashing();
    if (file()) return h?.kind === "done" && h.name === algorithm() ? h.digest : undefined;
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
      return p && d ? { p, d } : false;
    },
    async ({ p, d }, signal): Promise<Verdict> => {
      const config = (await loadConfig()) ?? (await readConfig());
      if (config === null) throw new ApiError(0, "The server's networks could not be read.");
      return verify(p, d, { mainnet: config.networks.includes("mainnet"), fetchBlock, signal });
    },
  );

  const chooseProof = (f: File | undefined) => {
    if (!f) return;
    void readProofFile(f).then(setProofIn);
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
          onClear={() => setProofIn(undefined)}
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
          <Show when={hashing()?.kind === "failed"}>
            <p class="ots-slot__note ots-slot__note--bad">This file could not be read.</p>
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
          <Match when={!proof() || !digest()}>
            <Waiting proof={proof() !== undefined} digest={digest() !== undefined} />
          </Match>
          <Match when={verdict.state === "errored" && !(verdict.error instanceof ProofError)}>
            <ErrorState title="Could not check the block" error={verdict.error} retry={refetch} />
          </Match>
          <Match when={verdict.state === "errored"}>
            <NotAProof error={verdict.error as ProofError} />
          </Match>
          <Match when={verdict.loading || verdict.latest === undefined}>
            <Loading label="Checking the block" />
          </Match>
          <Match when={verdict.latest}>
            {(v) => <Result v={v()} digest={digest() ?? new Uint8Array()} proof={proof()} />}
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
  malformed: "This proof is damaged",
};

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

function Result(props: { v: Verdict; digest: Uint8Array; proof: Proof | undefined }) {
  return (
    <NetworkScope value="mainnet">
      <Switch>
        <Match when={props.v.kind === "verified" && props.v}>
          {(v) => <Verified v={v()} digest={props.digest} proof={props.proof} />}
        </Match>
        <Match when={props.v.kind === "wrong-file" && props.v}>
          {(v) => (
            <Verdictbox
              tone="negative"
              status="Different file"
              title="This proof is for a different file"
            >
              <p>
                The proof was made for a file whose {HASH_NAMES[props.proof?.fileHash ?? "sha256"]}{" "}
                is not your file's. A single changed byte, another line ending or a re-saved copy
                makes a different file.
              </p>
              <dl class="ots-pair">
                <dt>Your file</dt>
                <dd class="mono ots-hex-value">{toHex(v().fileDigest)}</dd>
                <dt>The proof's file</dt>
                <dd class="mono ots-hex-value">{toHex(v().proofDigest)}</dd>
              </dl>
            </Verdictbox>
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
                  Following the proof's steps from your file ends in a value that is not the merkle
                  root of the block it names. The proof is damaged, or was made to look like a
                  timestamp it is not. Your file matches the proof's start.
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
                  {(c) => <Work digest={props.digest} leaf={c().leaf} block={c().block} />}
                </Show>
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
                The proof names a block this server's node does not have: a height above its newest
                block, or a block on a chain it does not follow. Nothing here says the proof is
                wrong; check it again later, or on another node.
              </p>
              <Also checks={v().checks} others={v().others} except={v().checks[0]} />
            </Verdictbox>
          )}
        </Match>
        <Match when={props.v.kind === "pending" && props.v}>
          {(v) => (
            <Verdictbox tone="caution" status="Pending" title="Not verified yet">
              <p>
                This proof holds only a calendar's promise to put your file's digest into a Bitcoin
                block. It has no Bitcoin attestation yet, so there is nothing to check.
              </p>
              <p>
                A calendar usually gets it into a block within a few hours. Then upgrade the proof
                with your OpenTimestamps client (<code class="mono">ots upgrade</code> and the
                proof's file name), and check the upgraded proof here.
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
                The proof's attestations are for Bitcoin mainnet (block
                {v().heights.length === 1 ? "" : "s"}{" "}
                {v()
                  .heights.map((h) => groupDigits(h))
                  .join(", ")}
                ), and this server has no mainnet node to look{" "}
                {v().heights.length === 1 ? "it" : "them"} up on. Your file matches the proof's
                start; check the block on an explorer or a node that follows mainnet.
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
  proof: Proof | undefined;
}) {
  const c = () => props.v.check;
  const weak = () =>
    props.proof?.fileHash === "sha1" || c().leaf.path.some((op) => op.kind === "sha1");
  return (
    <Verdictbox
      tone="positive"
      status="Verified"
      title={
        <>
          This file existed before{" "}
          <Link class="ots-verdict__block" href={paths.block(c().block.hash)}>
            block <span class="num">{groupDigits(c().height)}</span>
          </Link>
        </>
      }
    >
      <p class="ots-when">
        Block {groupDigits(c().height)} was mined on <TimeUtc time={c().block.time} />,{" "}
        <TimeAgo time={c().block.time} />.
      </p>
      <p>
        This proves the file existed no later than that block. It does not say who made the file or
        who held it, and it does not say the file was new then: it may be older. A block's time is
        set by its miner and can be off by up to about two hours.
      </p>
      <Show when={weak()}>
        <p class="ots-caveat">
          This proof relies on SHA-1, which is no longer safe against forged collisions: someone who
          made two files with the same SHA-1 could timestamp one and claim the other.
        </p>
      </Show>
      <Also checks={props.v.checks} others={props.v.others} except={c()} />
      <Work digest={props.digest} leaf={c().leaf} block={c().block} />
    </Verdictbox>
  );
}

/** The proof's other attestations: other Bitcoin blocks as checked, the rest named as not checked. */
function Also(props: { checks: Check[]; others: Leaf[]; except?: Check | undefined }) {
  const rest = () => props.checks.filter((c) => c !== props.except);
  const skipped = () => props.checks.length >= MAX_CHECKS;
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
        <p class="muted">This page checks at most {MAX_CHECKS} Bitcoin blocks of one proof.</p>
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
function Work(props: { digest: Uint8Array; leaf: Leaf; block: Block }) {
  const reaches = () => toHex(props.leaf.message) === toHex(props.block.merkleRoot);
  const list = () => steps(props.digest, props.leaf);
  const display = () => toHex(reversed(props.block.merkleRoot));
  return (
    <More label={`Show the ${list().length} steps from your file to the block`}>
      <p>
        Each step works on the value before it: a hash, or bytes added before or after it. The
        values are shortened; hover or long-press one for all of it.
      </p>
      <ol class="ots-steps">
        <li class="ots-step ots-step--end">
          <span class="ots-step__op">Your file's digest</span>
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
                    Then up block {groupDigits(props.block.height)}'s merkle tree, {n()}{" "}
                    {n() === 1 ? "level" : "levels"}: at each, the sibling is joined on its side and
                    the pair hashed twice with SHA-256
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
                      This is the transaction that wrote the commitment:{" "}
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
