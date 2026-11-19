// A chart's data as a CSV file (RFC 4180), built in the browser from what it draws
// (docs/FRONTEND.md "Charts"). Pure, but for `saveCsv`.
import type { ChartProps } from "./Chart";
import type { Value } from "./geometry";

export interface CsvColumn {
  header: string;
  values: readonly Value[];
}

/** A header with its unit, when the values have one: "Balance (sat)". */
const named = (name: string, unit: string | undefined) =>
  unit === undefined ? name : `${name} (${unit})`;

/** A column per series, band end, note and layer, each in its raw unit. */
export function chartColumns(props: ChartProps): CsvColumn[] {
  return [
    ...(props.series ?? []).map((s) => ({ header: named(s.name, s.rawUnit), values: s.values })),
    ...(props.bands ?? []).flatMap((b) => [
      { header: named(`${b.name}, low`, b.rawUnit), values: b.lo },
      { header: named(`${b.name}, high`, b.rawUnit), values: b.hi },
    ]),
    ...(props.notes ?? []).map((n) => ({ header: named(n.name, n.rawUnit), values: n.values })),
    ...(props.layers ?? []).map((l) => ({
      header: named(l.name, props.layerUnit),
      values: l.values,
    })),
  ];
}

/**
 * A text field, quoted. One that a spreadsheet would read as a formula (OWASP's CSV injection
 * guidance: `=`, `+`, `-`, `@` or their full-width forms, a tab, a carriage return or a line feed
 * first, here also after leading spaces) gets a `'` in front, so it stays text: a pool's name is a
 * miner's words.
 */
export function textField(text: string): string {
  const risky = /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/u.test(text);
  return `"${(risky ? `'${text}` : text).replaceAll('"', '""')}"`;
}

/** A number field: only a finite number is written, anything else is an empty cell. */
export const numberField = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : "";

/** ISO 8601 in UTC, to the second unless the time has a fraction; empty for no real time. */
function isoField(t: number): string {
  if (!Number.isFinite(t)) return "";
  const d = new Date(t * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toISOString().replace(".000Z", "Z");
}

/** The whole file: a row per point, its time twice (ISO 8601 UTC and unix seconds), then each
 * column's raw number, a gap left empty. CRLF line ends, as RFC 4180 has them. */
export function chartCsv(x: readonly number[], columns: readonly CsvColumn[]): string {
  const head = ["Time (UTC, ISO 8601)", "Unix time (s)", ...columns.map((c) => c.header)];
  const rows = [head.map((h) => textField(h)).join(",")];
  x.forEach((t, i) => {
    rows.push(
      [
        textField(isoField(t)),
        numberField(t),
        ...columns.map((c) => numberField(c.values[i])),
      ].join(","),
    );
  });
  return `${rows.join("\r\n")}\r\n`;
}

/** `rbitcoin-<network>-<subject>-<YYYY-MM-DD>.csv`, in lower-case letters, digits and dashes
 * only: the subject can hold a pool's or a node's own words. */
export function csvFileName(subject: string, network: string, date: Date): string {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replaceAll(/\p{M}/gu, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "");
  const day = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
  const what = slug(subject).slice(0, 80).replace(/-+$/u, "") || "chart";
  return `${["rbitcoin", slug(network), what, day].filter((p) => p !== "").join("-")}.csv`;
}

/** Hands the file to the browser as a download, from a `blob:` link the CSP allows. */
export function saveCsv(csv: string, name: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
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
