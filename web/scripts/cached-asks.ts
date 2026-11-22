// One-off codemod: turns every API call under src/ from "cached unless `fresh: true`" to "fresh
// unless `cached: true`", keeping what each call does. Run from web/ on a tree whose `Ask` in
// src/lib/api.ts still has `fresh`: `bun scripts/cached-asks.ts` (add `--dry` to list the calls).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseSync } from "rolldown/utils";

/** Each call's options argument, by its place. */
const OPTIONS_AT: Record<string, number> = {
  fetchApi: 2,
  fetchApp: 2,
  fetchStamped: 2,
  createApi: 1,
  postApp: 3,
};

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
interface Edit {
  start: number;
  end: number;
  text: string;
}

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const v of Object.values(node)) {
    for (const child of Array.isArray(v) ? v : [v]) if (isNode(child)) yield* walk(child);
  }
}

const keyName = (p: Node): string | undefined => {
  const key = p["key"];
  return p.type === "Property" && isNode(key) && key.type === "Identifier"
    ? String(key["name"])
    : undefined;
};

const FLIPPED: Record<string, string> = { "===": "!==", "!==": "===", "==": "!=", "!=": "==" };

/** `!expr`, as an equality turned round where it is one, bracketed unless it is one term. */
function negate(src: string, e: Node): string {
  const text = src.slice(e.start, e.end);
  const op = FLIPPED[String(e["operator"])];
  if (e.type === "BinaryExpression" && op !== undefined) {
    const [l, r] = [e["left"] as Node, e["right"] as Node];
    return `${src.slice(l.start, l.end)} ${op} ${src.slice(r.start, r.end)}`;
  }
  return ["Identifier", "MemberExpression", "CallExpression"].includes(e.type)
    ? `!${text}`
    : `!(${text})`;
}

/**
 * The edits that keep one options object's behaviour under the new default, or why it needs a
 * person. `drop` removes the whole argument when nothing is left in it.
 */
function convertObject(src: string, opts: Node, cached: string, drop?: Edit): Edit[] | string {
  const props = opts["properties"] as Node[];
  if (props.some((p) => p.type !== "Property")) return "options with a spread";
  const i = props.findIndex((p) => keyName(p) === "fresh");
  const fresh = props[i];
  if (fresh === undefined) {
    if (cached === "") return [];
    const last = props.at(-1);
    return last === undefined
      ? [{ start: opts.start, end: opts.end, text: `{ ${cached} }` }]
      : [{ start: last.end, end: last.end, text: `, ${cached}` }];
  }
  const value = fresh["value"] as Node;
  const always = value.type === "Literal" && value["value"] === true;
  const never = value.type === "Literal" && value["value"] === false;
  if (always || cached === "") {
    // Fresh is now the default: the option goes, and the argument with it when it held nothing else.
    if (props.length === 1) return [drop ?? { start: opts.start, end: opts.end, text: "{}" }];
    const next = props[i + 1];
    const prev = props[i - 1];
    if (next) return [{ start: fresh.start, end: next.start, text: "" }];
    return prev ? [{ start: prev.end, end: fresh.end, text: "" }] : "no property beside fresh";
  }
  return [
    { start: fresh.start, end: fresh.end, text: never ? cached : `cached: ${negate(src, value)}` },
  ];
}

/** The object literals an options argument can be: itself, either branch, or a const it names. */
function convertOptions(
  src: string,
  opts: Node,
  cached: string,
  consts: Map<string, Node | undefined>,
  drop?: Edit,
): Edit[] | string {
  if (opts.type === "ObjectExpression") return convertObject(src, opts, cached, drop);
  if (opts.type === "ConditionalExpression") {
    const out: Edit[] = [];
    for (const branch of [opts["consequent"], opts["alternate"]] as Node[]) {
      const e = convertOptions(src, branch, cached, consts);
      if (typeof e === "string") return e;
      out.push(...e);
    }
    return out;
  }
  if (opts.type === "Identifier") {
    const init = consts.get(String(opts["name"]));
    return init === undefined
      ? "options named by no const in scope"
      : convertOptions(src, init, cached, consts);
  }
  return `options that are a ${opts.type}`;
}

/** The edits that keep one call's behaviour under the new default, or why it needs a person. */
function convert(
  src: string,
  call: Node,
  name: string,
  consts: Map<string, Node | undefined>,
): Edit[] | string {
  const args = call["arguments"] as Node[];
  const at = OPTIONS_AT[name] ?? -1;
  const opts = args[at];
  // A POST is never cached by the browser: it takes no option either way.
  const cached = name === "postApp" ? "" : "cached: true";
  const prev = args[at - 1];
  if (prev === undefined) return "fewer arguments than the options' place";
  if (opts === undefined) {
    return cached === "" ? [] : [{ start: prev.end, end: prev.end, text: `, { ${cached} }` }];
  }
  return convertOptions(src, opts, cached, consts, { start: prev.end, end: opts.end, text: "" });
}

interface Binding {
  name: string;
  init: Node;
  /** The block it is declared in. */
  scope: Node;
}

/** Every `const name = <init>` in a file, with the block that holds it. */
function bindingsOf(node: Node, scope: Node, out: Binding[] = []): Binding[] {
  const inner = node.type === "BlockStatement" ? node : scope;
  const id = node["id"];
  const init = node["init"];
  if (
    node.type === "VariableDeclarator" &&
    isNode(id) &&
    id.type === "Identifier" &&
    isNode(init)
  ) {
    out.push({ name: String(id["name"]), init, scope });
  }
  for (const v of Object.values(node)) {
    for (const child of Array.isArray(v) ? v : [v])
      if (isNode(child)) bindingsOf(child, inner, out);
  }
  return out;
}

/** What each name means at `at`: the binding in the innermost block around it. */
function constsAt(bindings: readonly Binding[], at: number): Map<string, Node | undefined> {
  const consts = new Map<string, Node | undefined>();
  const width = (b: Binding) => b.scope.end - b.scope.start;
  const seen = bindings.filter((b) => b.scope.start <= at && at < b.scope.end);
  seen.sort((a, b) => width(b) - width(a));
  for (const b of seen) consts.set(b.name, b.init);
  return consts;
}

const dry = process.argv.includes("--dry");
const api = readFileSync("src/lib/api.ts", "utf8");
if (!/\bfresh\?: boolean/.test(api)) {
  console.error("src/lib/api.ts has no `fresh` option: this tree is already converted.");
  process.exit(1);
}

const manual: string[] = [];
let calls = 0;
const files = readdirSync("src", { recursive: true, encoding: "utf8" });
// oxlint-disable-next-line unicorn/no-array-sort -- sorts the fresh array readdirSync made
for (const entry of files.sort()) {
  const file = `src/${entry}`;
  if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || file === "src/lib/api.ts") continue;
  const src = readFileSync(file, "utf8");
  const program = parseSync(file, src).program as unknown as Node;
  const bindings = bindingsOf(program, program);
  const edits: Edit[] = [];
  for (const node of walk(program)) {
    const callee = node["callee"];
    if (node.type !== "CallExpression" || !isNode(callee) || callee.type !== "Identifier") continue;
    const name = String(callee["name"]);
    if (!(name in OPTIONS_AT)) continue;
    calls += 1;
    const line = src.slice(0, node.start).split("\n").length;
    const out = convert(src, node, name, constsAt(bindings, node.start));
    if (typeof out === "string") manual.push(`${file}:${line} ${name}: ${out}`);
    else edits.push(...out);
    if (dry) {
      const after = typeof out === "string" ? "MANUAL" : out.map((e) => JSON.stringify(e.text));
      const before = src.slice(node.start, node.end).replaceAll(/\s+/g, " ");
      console.log(`${file}:${line}\t${before.slice(0, 150)}\t${String(after)}`);
    }
  }
  if (dry || edits.length === 0) continue;
  // A const shared by two calls is edited once.
  const once = new Map(edits.map((e) => [`${e.start}:${e.end}`, e]));
  let out = src;
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy, last edit first
  for (const e of [...once.values()].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  writeFileSync(file, out);
}
console.error(`${calls} calls${manual.length > 0 ? `; ${manual.length} need a person:` : ""}`);
for (const m of manual) console.error(`  ${m}`);
process.exit(manual.length > 0 ? 1 : 0);
