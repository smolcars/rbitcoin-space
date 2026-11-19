import { describe, expect, it } from "vitest";
import { chartColumns, chartCsv, csvFileName, numberField, textField } from "./csv";

const lines = (csv: string) => csv.split("\r\n");

describe("chart CSV", () => {
  it("quotes text per RFC 4180", () => {
    expect(textField("plain")).toBe('"plain"');
    expect(textField('say "hi", twice')).toBe('"say ""hi"", twice"');
    expect(textField("two\nlines")).toBe('"two\nlines"');
    expect(textField("")).toBe('""');
  });

  it("keeps a would-be formula as text", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "  =cmd", "\n=cmd", "\nx"]) {
      expect(textField(bad).startsWith(`"'`)).toBe(true);
    }
    // Some spreadsheet locales read the full-width signs as the plain ones.
    for (const wide of ["＝1+1", "＋1", "－1", "＠SUM(A1)"]) {
      expect(textField(wide).startsWith(`"'`)).toBe(true);
    }
    expect(textField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(textField("Foundry USA")).toBe('"Foundry USA"');
    expect(textField("a=b")).toBe('"a=b"');
  });

  it("writes only finite numbers", () => {
    expect(numberField(1.5)).toBe("1.5");
    expect(numberField(-3)).toBe("-3");
    for (const v of [null, undefined, Number.NaN, Infinity, -Infinity, "1", "=1"]) {
      expect(numberField(v)).toBe("");
    }
  });

  it("writes a row per point, a time axis twice and gaps empty", () => {
    const csv = chartCsv(
      [1_700_000_000, 1_700_086_400, 1_700_172_800.5],
      [{ header: "Balance (sat)", values: [5, null] }],
    );
    expect(lines(csv)).toStrictEqual([
      '"Time (UTC, ISO 8601)","Unix time (s)","Balance (sat)"',
      '"2023-11-14T22:13:20Z",1700000000,5',
      '"2023-11-15T22:13:20Z",1700086400,',
      '"2023-11-16T22:13:20.500Z",1700172800.5,',
      "",
    ]);
  });

  it("leaves a time it cannot read empty", () => {
    expect(lines(chartCsv([1e20], []))[1]).toBe('"",100000000000000000000');
  });

  it("gives each series, band end, note and layer a column in its raw unit", () => {
    const columns = chartColumns({
      label: "Test",
      x: [1, 2],
      left: { format: String },
      series: [{ name: "Median", values: [2, 3], draw: "line", format: String, rawUnit: "sat/vB" }],
      bands: [{ name: "Middle 80%", lo: [1, null], hi: [4, null], format: String, rawUnit: "x" }],
      notes: [{ name: "Block", values: [10, 11], format: String }],
      layers: [{ name: "=evil pool", values: [0.25, 0.5] }],
      layerUnit: "0-1",
    });
    const csv = chartCsv([1, 2], columns);
    expect(lines(csv)[0]).toBe(
      `"Time (UTC, ISO 8601)","Unix time (s)","Median (sat/vB)","Middle 80%, low (x)","Middle 80%, high (x)","Block","'=evil pool (0-1)"`,
    );
    expect(lines(csv)[1]).toBe('"1970-01-01T00:00:01Z",1,2,1,4,10,0.25');
    expect(lines(csv)[2]).toBe('"1970-01-01T00:00:02Z",2,3,,,11,0.5');
  });

  it("names the file in safe characters", () => {
    const day = new Date(Date.UTC(2026, 10, 19, 23, 59));
    expect(csvFileName("Hashrate and difficulty, the last year", "mainnet", day)).toBe(
      "rbitcoin-mainnet-hashrate-and-difficulty-the-last-year-2026-11-19.csv",
    );
    expect(csvFileName("../../ <script>Ünïcode/\\: pool", "regtest", day)).toBe(
      "rbitcoin-regtest-script-unicode-pool-2026-11-19.csv",
    );
    expect(csvFileName("⚡⚡⚡", "signet", day)).toBe("rbitcoin-signet-chart-2026-11-19.csv");
    expect(csvFileName("a".repeat(300), "mainnet", day)).toHaveLength(
      "rbitcoin-mainnet--2026-11-19.csv".length + 80,
    );
  });
});
