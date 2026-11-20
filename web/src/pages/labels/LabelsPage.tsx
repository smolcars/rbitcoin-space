// The reader's labels: every one this browser keeps, to find, edit and delete, and BIP329 files in
// and out (docs/FRONTEND.md "Your labels"). Everything here happens in the browser: the page asks
// the server for nothing, and nothing typed or read here goes into a URL.
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Column, DataTable } from "../../components/DataTable";
import { Hash } from "../../components/Hash";
import { YourLabel } from "../../components/labels/Label";
import { LabelEditor } from "../../components/labels/LabelEditor";
import { Pagination } from "../../components/Pagination";
import { SectionHeader } from "../../components/SectionHeader";
import { Loading } from "../../components/States";
import { recognise } from "../../lib/address";
import { groupDigits } from "../../lib/format";
import { shownLabels } from "../../lib/labels";
import {
  fileName,
  MAX_FILE,
  MAX_LABEL,
  readFile,
  type ReadFile,
  SKIP_WORDS,
} from "../../lib/labels/bip329";
import {
  exportFile,
  type ImportPlan,
  LabelStoreError,
  planImport,
  records,
  remove,
  removeAll,
  runImport,
  snapshot,
  type Stored,
} from "../../lib/labels/db";
import { type Network, onNetwork, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import "../../components/Button.css";
import "./LabelsPage.css";

const PER_PAGE = 50;

const TYPE_NAMES: Record<string, string> = {
  tx: "Transaction",
  addr: "Address",
  pubkey: "Public key",
  input: "Input",
  output: "Output",
  xpub: "Extended public key",
  spscan: "Silent payments scan key",
};

/** What a record names, in words; a type this site does not know is named by its own word. */
const typeName = (type: string) => TYPE_NAMES[type] ?? `Other (${type})`;

/**
 * Where a record's page is, or undefined for one the site cannot show (an xpub is never looked up:
 * that would send the key to the server). A transaction, input or output is on the network the
 * reader is on; an address on its own network, the reader's when its form fits more than one.
 */
export function pageOf(r: Pick<Stored, "type" | "ref">, network: Network): string | undefined {
  const txid = /^[0-9a-f]{64}/i.exec(r.ref)?.[0]?.toLowerCase();
  switch (r.type) {
    case "tx":
    case "input":
    case "output": {
      return txid === undefined ? undefined : onNetwork(network, paths.tx(txid));
    }
    case "addr":
    case "pubkey": {
      const found = recognise(r.ref);
      if (!found || (r.type === "pubkey") !== (found.type === "p2pk")) return undefined;
      const on = found.networks.includes(network) ? network : found.networks[0];
      return on === undefined ? undefined : onNetwork(on, paths.address(found.address));
    }
    default: {
      return undefined;
    }
  }
}

/** A file's size in words: "34.2 MB". */
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type Phase =
  | { kind: "idle" }
  | { kind: "reading"; name: string; done: number; total: number }
  | { kind: "planned"; name: string; read: ReadFile; plan: ImportPlan; long: number }
  | { kind: "saving"; done: number; total: number }
  | { kind: "refused"; words: string };

export default function LabelsPage() {
  usePageTitle(() => "Your labels");
  const network = useNetwork();
  const [state, setState] = createSignal<"loading" | "ready" | "unavailable">("loading");
  onSettled(() => {
    records()
      .then(() => setState("ready"))
      .catch((e: unknown) => {
        setState(
          e instanceof LabelStoreError && e.kind !== "unavailable" ? "ready" : "unavailable",
        );
      });
  });
  // Follows every write, from this page, an editor, or another tab.
  const all = createMemo(() => {
    shownLabels();
    if (state() !== "ready") return [];
    // Newest first.
    const list = snapshot();
    const out: Stored[] = [];
    for (let i = list.length - 1; i >= 0; i--) out.push(list[i] as Stored);
    return out;
  });

  return (
    <div class="wrap labels-page">
      <header class="labels-page__head">
        <h1>Your labels</h1>
        <p class="labels-page__lead">
          Your own names for transactions and addresses, shown beside them wherever this site lists
          them. Add one from a transaction's or an address's page, or import a file from your
          wallet.
        </p>
      </header>
      <aside class="labels-page__where" aria-labelledby="labels-where">
        <h2 id="labels-where">Kept in this browser only</h2>
        <p>
          Your labels never leave this browser: the site does not send them to its server or
          anywhere else, and it cannot see them. They are lost if this site's data is cleared, and
          another browser or device does not have them. Export them to keep a copy: the file is in
          BIP329, the label format wallets such as Sparrow and Nunchuk import.
        </p>
      </aside>
      <Show when={state() !== "loading"} fallback={<Loading label="Reading your labels" />}>
        <Show
          when={state() === "ready"}
          fallback={
            <section class="labels-page__off" aria-labelledby="labels-off">
              <SectionHeader title="Labels cannot be kept here" id="labels-off" />
              <p>
                This browser is not letting the site keep anything (a private window, or site data
                blocked for this site), so there is nowhere to keep labels. The rest of the site
                works as before.
              </p>
            </section>
          }
        >
          <Manager all={all()} network={network()} />
        </Show>
      </Show>
    </div>
  );
}

function Manager(props: { all: Stored[]; network: Network }) {
  const [query, setQuery] = createSignal("");
  const [page, setPage] = createSignal(1);
  const [editing, setEditing] = createSignal<string | undefined>();
  const [said, setSaid] = createSignal("");
  const [confirmAll, setConfirmAll] = createSignal(false);
  const [phase, setPhase] = createSignal<Phase>({ kind: "idle" });
  const [problem, setProblem] = createSignal("");
  let fileInput: HTMLInputElement | undefined;
  let reading = 0;

  // Lower-cased once per change of the list, not once per keystroke.
  const haystack = createMemo(() =>
    props.all.map((r) => `${r.label ?? ""}\n${r.ref}`.toLowerCase()),
  );
  const found = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (q === "") return props.all;
    const hay = haystack();
    return props.all.filter((_, i) => hay[i]?.includes(q) === true);
  });
  const pageCount = () => Math.max(1, Math.ceil(found().length / PER_PAGE));
  const shown = createMemo(() => {
    const p = Math.min(page(), pageCount());
    return found().slice((p - 1) * PER_PAGE, p * PER_PAGE);
  });

  const fail = (e: unknown) =>
    setProblem(e instanceof LabelStoreError ? e.message : "That could not be done. Try again.");

  const choose = (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    setProblem("");
    setSaid("");
    if (file.size > MAX_FILE) {
      setPhase({
        kind: "refused",
        words: `This file is ${megabytes(file.size)}. The most this page reads is ${megabytes(MAX_FILE)}: split it into smaller files and import each.`,
      });
      return;
    }
    void readChosen(file);
  };

  /** Reads a chosen file and says what importing it would do; a newer choice or Stop drops it. */
  const readChosen = async (file: File) => {
    const run = ++reading;
    setPhase({ kind: "reading", name: file.name, done: 0, total: 0 });
    const heard = (done: number, total: number) => {
      if (run === reading) setPhase({ kind: "reading", name: file.name, done, total });
    };
    try {
      const read = await readFile(await file.text(), heard, () => run !== reading);
      if (run !== reading) return;
      const next = await planImport(read.records);
      const long = read.records.filter((r) => (r.label?.length ?? 0) > MAX_LABEL).length;
      if (run === reading) setPhase({ kind: "planned", name: file.name, read, plan: next, long });
    } catch (error) {
      if (run !== reading) return;
      setPhase({
        kind: "refused",
        words:
          error instanceof LabelStoreError
            ? error.message
            : "The file could not be read. Check that it is a text file of labels.",
      });
    }
  };

  const commitImport = (plan: ImportPlan) => {
    const total = plan.added.length + plan.replaced.length;
    setPhase({ kind: "saving", done: 0, total });
    runImport(plan, (done) => setPhase({ kind: "saving", done, total }))
      .then(() => {
        setPhase({ kind: "idle" });
        setPage(1);
        setSaid(`Imported ${groupDigits(total)} ${total === 1 ? "label" : "labels"}.`);
      })
      .catch((e: unknown) => {
        setPhase({ kind: "idle" });
        fail(e);
      });
  };

  const cancelImport = () => {
    reading++;
    setPhase({ kind: "idle" });
  };

  const save = () => {
    setProblem("");
    exportFile()
      .then(({ text, count }) => {
        const name = fileName(new Date());
        saveFile(text, name);
        setSaid(`Saved ${groupDigits(count)} ${count === 1 ? "label" : "labels"} as ${name}.`);
      })
      .catch(fail);
  };

  const deleteAll = () => {
    const n = props.all.length;
    removeAll()
      .then(() => {
        setConfirmAll(false);
        setPage(1);
        setSaid(`Deleted all ${groupDigits(n)} labels.`);
      })
      .catch(fail);
  };

  const columns: Column<Stored>[] = [
    {
      header: "Label",
      cell: (r) =>
        r.label === undefined ? (
          <span class="labels-page__none">No label</span>
        ) : (
          <YourLabel text={r.label} max={80} />
        ),
    },
    {
      header: "What",
      optional: true,
      cell: (r) => typeName(r.type),
    },
    {
      header: "Reference",
      cell: (r) => <Reference r={r} network={props.network} />,
    },
    {
      header: "Change",
      hidden: true,
      cell: (r) => (
        <span class="labels-page__row-actions">
          <button
            type="button"
            class="btn"
            aria-expanded={editing() === r.key ? "true" : "false"}
            onClick={() => setEditing((k) => (k === r.key ? undefined : r.key))}
          >
            Edit<span class="visually-hidden"> the label of {describe(r)}</span>
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => {
              setSaid("");
              remove([r.key])
                .then(() => setSaid(`Deleted the label of ${describe(r)}.`))
                .catch(fail);
            }}
          >
            Delete<span class="visually-hidden"> the label of {describe(r)}</span>
          </button>
        </span>
      ),
    },
  ];

  const busy = () => phase().kind === "reading" || phase().kind === "saving";

  return (
    <section class="labels-page__list" aria-labelledby="labels-title">
      <SectionHeader title="Labels" id="labels-title">
        <span class="num">
          {groupDigits(props.all.length)} {props.all.length === 1 ? "label" : "labels"}
        </span>
      </SectionHeader>
      <div class="labels-page__actions">
        <input
          ref={fileInput}
          class="visually-hidden"
          type="file"
          accept=".jsonl,.json,.txt,application/json,application/jsonl,text/plain"
          tabindex="-1"
          aria-hidden="true"
          onChange={choose}
        />
        <button type="button" class="btn" disabled={busy()} onClick={() => fileInput?.click()}>
          Import a file
        </button>
        <button
          type="button"
          class="btn"
          disabled={props.all.length === 0 || busy()}
          onClick={save}
        >
          Export a file
        </button>
        <button
          type="button"
          class="btn labels-page__delete-all"
          disabled={props.all.length === 0 || busy()}
          aria-expanded={confirmAll() ? "true" : "false"}
          aria-controls="labels-confirm-all"
          onClick={() => setConfirmAll((c) => !c)}
        >
          Delete all
        </button>
      </div>
      <div id="labels-confirm-all" class="labels-page__confirm" hidden={!confirmAll()}>
        <Show when={confirmAll()}>
          <p>
            Delete all {groupDigits(props.all.length)} labels from this browser? This cannot be
            undone: export them first to keep a copy.
          </p>
          <div class="labels-page__buttons">
            <button type="button" class="btn btn--danger" onClick={deleteAll}>
              Delete all labels
            </button>
            <button type="button" class="btn" onClick={() => setConfirmAll(false)}>
              Keep them
            </button>
          </div>
        </Show>
      </div>
      <ImportState phase={phase()} onImport={commitImport} onCancel={cancelImport} />
      <p class="labels-page__said" aria-live="polite">
        {said()}
      </p>
      <Show when={problem()}>
        <p class="labels-page__problem" role="alert">
          {problem()}
        </p>
      </Show>
      <Show when={props.all.length > 0}>
        <div class="labels-page__find">
          <label for="labels-find">Find a label</label>
          <input
            id="labels-find"
            type="search"
            autocomplete="off"
            spellcheck="false"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setPage(1);
            }}
          />
          <Show when={query().trim() !== ""}>
            <span class="labels-page__count num" aria-live="polite">
              {groupDigits(found().length)} found
            </span>
          </Show>
        </div>
      </Show>
      <DataTable
        caption="Your labels, newest first"
        columns={columns}
        rows={shown()}
        empty={
          <p class="labels-page__empty">
            {props.all.length === 0
              ? "No labels yet. Add one from a transaction's or an address's page, or import a file."
              : "No label matches."}
          </p>
        }
        rowNote={{
          when: (r) => editing() === r.key,
          render: (r) => (
            <LabelEditor
              type={r.type}
              reference={r.ref}
              record={r.key}
              what={describe(r)}
              current={r.label}
              done={(words) => {
                setEditing(undefined);
                if (words !== undefined) setSaid(words);
              }}
            />
          ),
        }}
      />
      <Show when={pageCount() > 1}>
        <Pagination
          page={Math.min(page(), pageCount())}
          pageCount={pageCount()}
          onPage={setPage}
          label="Label pages"
        />
      </Show>
    </section>
  );
}

/** A record's subject in words, for a button's name: "transaction 3a…9f". */
function describe(r: Stored): string {
  const short = r.ref.length > 20 ? `${r.ref.slice(0, 8)}…${r.ref.slice(-8)}` : r.ref;
  return `${typeName(r.type).toLowerCase()} ${short}`;
}

/** The reference, linked to its page where the site has one. */
function Reference(props: { r: Stored; network: Network }) {
  const href = () => pageOf(props.r, props.network);
  return (
    <Show when={href()} fallback={<Hash value={props.r.ref} copyLabel="Copy reference" fit />}>
      {(h) => (
        // A plain link: `href` already carries its network, which may not be the page's.
        <span class="hash hash--fit">
          <a class="hash__text tap-line" href={h()} title={props.r.ref}>
            <span class="hash__head">{props.r.ref.slice(0, -8)}</span>
            <span class="hash__tail">{props.r.ref.slice(-8)}</span>
          </a>
        </span>
      )}
    </Show>
  );
}

function ImportState(props: {
  phase: Phase;
  onImport: (plan: ImportPlan) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <>
      <Show when={props.phase.kind === "reading" && props.phase} keyed>
        {(p) => (
          <div class="labels-page__import" role="status">
            <p>
              Reading {p.name}
              {p.total > 0 ? `: ${groupDigits(p.done)} of ${groupDigits(p.total)} lines` : ""}
            </p>
            <progress max={p.total || 1} value={p.done} />
            <button type="button" class="btn" onClick={() => props.onCancel()}>
              Stop
            </button>
          </div>
        )}
      </Show>
      <Show when={props.phase.kind === "saving" && props.phase} keyed>
        {(p) => (
          <div class="labels-page__import" role="status">
            <p>
              Saving {groupDigits(p.done)} of {groupDigits(p.total)} labels
            </p>
            <progress max={p.total || 1} value={p.done} />
          </div>
        )}
      </Show>
      <Show when={props.phase.kind === "refused" && props.phase} keyed>
        {(p) => (
          <div class="labels-page__import labels-page__import--refused" role="alert">
            <p>{p.words}</p>
            <button type="button" class="btn" onClick={() => props.onCancel()}>
              Close
            </button>
          </div>
        )}
      </Show>
      <Show when={props.phase.kind === "planned" && props.phase} keyed>
        {(p) => <Plan p={p} onImport={props.onImport} onCancel={props.onCancel} />}
      </Show>
    </>
  );
}

/** What an import will do, said before it does it. */
function Plan(props: {
  p: Extract<Phase, { kind: "planned" }>;
  onImport: (plan: ImportPlan) => void;
  onCancel: () => void;
}) {
  const n = (x: number, one: string, many: string) => `${groupDigits(x)} ${x === 1 ? one : many}`;
  const added = () => props.p.plan.added.length;
  const replaced = () => props.p.plan.replaced.length;
  const total = () => added() + replaced();
  const skipped = () => [...props.p.read.skipped.values()].reduce((a, b) => a + b, 0);
  return (
    <div class="labels-page__import" role="status">
      <p class="labels-page__import-title">
        {props.p.name}: {n(props.p.read.lines, "line", "lines")} read
      </p>
      <ul class="labels-page__plan">
        <li>{n(added(), "label is new", "labels are new")} to this browser.</li>
        <Show when={replaced() > 0}>
          <li>
            {n(replaced(), "replaces a label", "replace labels")} you have: the file's label wins,
            and a line without a label keeps yours.
          </li>
        </Show>
        <Show when={props.p.read.replaced > 0}>
          <li>
            {n(props.p.read.replaced, "line repeats", "lines repeat")} an earlier line for the same
            thing: the later line is kept.
          </li>
        </Show>
        <Show when={props.p.long > 0}>
          <li>
            {n(props.p.long, "label is", "labels are")} longer than {MAX_LABEL} characters: kept
            whole, and shown shortened.
          </li>
        </Show>
        <Show when={skipped() > 0}>
          <li class="labels-page__skipped">
            {n(skipped(), "line was", "lines were")} skipped
            {props.p.read.firstSkipped.length > 0
              ? ` (from line ${props.p.read.firstSkipped.join(", ")}${skipped() > props.p.read.firstSkipped.length ? ", …" : ""})`
              : ""}
            :{" "}
            {[...props.p.read.skipped]
              .map(([why, count]) => `${groupDigits(count)} ${SKIP_WORDS[why]}`)
              .join("; ")}
            .
          </li>
        </Show>
      </ul>
      <div class="labels-page__buttons">
        <Show when={total() > 0}>
          <button
            type="button"
            class="btn btn--accent"
            onClick={() => props.onImport(props.p.plan)}
          >
            Import {n(total(), "label", "labels")}
          </button>
        </Show>
        <button type="button" class="btn" onClick={() => props.onCancel()}>
          {total() > 0 ? "Cancel" : "Close"}
        </button>
      </div>
    </div>
  );
}

/** Hands the file to the browser as a download, from a `blob:` link the CSP allows. */
function saveFile(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/jsonl;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked once the browser has started reading it; at once is too early for Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
