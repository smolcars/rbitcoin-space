import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { NETWORKS, type Network } from "../lib/network";
import { classify } from "./query";
import { createSearch, describe as read, type Get, probeOrder, resolve as lead } from "./search";

const TXID = "65428488a6202f1d681d053b3ff5d8ea9f5b0e5e1e0dcf7bf2e4c1e5a3f9c2e1";
const BLOCK = "00000000000000000000e13ad5e424f6ba7208b0c1a9a687e9ccc4d62b3b094c";
const KEY = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";
const REGTEST_BLOCK = "2ac64444e3172ee94aeeff3b09014b1d69b4daeccddac025d493332d54f6f145";

const notFound = () => Promise.reject(new ApiError(404, "Not found."));

/** A fake API: the paths that exist answer, the rest are 404. Records every path asked. */
function api(exist: readonly string[]) {
  const asked: string[] = [];
  const probe = (path: string) => {
    asked.push(path);
    return exist.includes(path) ? Promise.resolve({}) : notFound();
  };
  return { asked, probe };
}

describe("read (describe)", () => {
  it.each([
    ["840000", "mainnet", "Block 840\u{202F}000", true],
    [TXID, "mainnet", "Transaction or block", true],
    [`${TXID}:1`, "mainnet", "Transaction", true],
    [`https://mempool.space/block/${BLOCK}`, "mainnet", "Block hash", true],
    ["bc1pfeessrawgf", "mainnet", "P2A address", true],
    ["tb1pfees9rn5nz", "mainnet", "Signet, Testnet4 or Testnet5 address", true],
    ["tb1pfees9rn5nz", "testnet5", "P2A address", true],
    ["2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN", "signet", "P2SH address", true],
    [
      "2ND8PB9RrfCaAcjfjP1Y6nAgFd9zWHYX4DN",
      "mainnet",
      "Signet, Testnet4, Testnet5 or Regtest address",
      true,
    ],
    [TXID.slice(0, 20), "mainnet", "20 of 64 characters", false],
    ["hello", "mainnet", "Not recognised", false],
    ["x".repeat(600), "mainnet", "Too long", false],
    [KEY, "mainnet", "Lightning node", true],
    ["811984x2037x0", "mainnet", "Lightning channel", true],
  ] as const)("%s on %s reads %j", (q, network, label, ready) => {
    expect(read(q, network)).toStrictEqual({ label, ready });
  });

  it("reads a name as a node search only where Lightning is on", () => {
    expect(read("noderunner", "signet", true)).toStrictEqual({ label: "Node name", ready: true });
    expect(read("noderunner", "signet", false)).toStrictEqual({
      label: "Not recognised",
      ready: false,
    });
    // A key's start searches nodes; a txid's start still counts its characters.
    expect(read("03864ef0", "signet", true)).toStrictEqual({
      label: "8 of 64 characters",
      ready: true,
    });
    // Under 3 characters the index answers nothing.
    expect(read("no", "signet", true)).toStrictEqual({ label: "Not recognised", ready: false });
  });
});

describe("probeOrder", () => {
  it("asks for a block first when the hash meets proof of work, else a transaction", () => {
    expect(probeOrder(BLOCK, null)).toStrictEqual(["block", "tx"]);
    expect(probeOrder(TXID, null)).toStrictEqual(["tx", "block"]);
    expect(probeOrder(REGTEST_BLOCK, null)).toStrictEqual(["tx", "block"]);
  });
  it("follows what a link or an outpoint says", () => {
    expect(probeOrder(TXID, "block")).toStrictEqual(["block", "tx"]);
    expect(probeOrder(BLOCK, "tx")).toStrictEqual(["tx", "block"]);
  });
});

describe("resolve (lead)", () => {
  it("goes to a height's block page without asking: that page says when it is not mined yet", async () => {
    const { asked, probe } = api([]);
    await expect(lead(classify("#99,999,999"), probe)).resolves.toStrictEqual({
      kind: "go",
      path: "/block/99999999",
    });
    expect(asked).toStrictEqual([]);
  });

  it("goes to an address page without asking, whatever its network", async () => {
    const { asked, probe } = api([]);
    await expect(lead(classify("tb1pfees9rn5nz"), probe)).resolves.toStrictEqual({
      kind: "go",
      path: "/address/tb1pfees9rn5nz",
    });
    expect(asked).toStrictEqual([]);
  });

  it("goes to a Lightning node or channel page without asking", async () => {
    const { asked, probe } = api([]);
    await expect(lead(classify(KEY), probe)).resolves.toStrictEqual({
      kind: "go",
      path: `/lightning/node/${KEY}`,
    });
    await expect(lead(classify("892785849701564416"), probe)).resolves.toStrictEqual({
      kind: "go",
      path: "/lightning/channel/811984x2037x0",
    });
    expect(asked).toStrictEqual([]);
  });

  it("finds a block hash in one request", async () => {
    const { asked, probe } = api([`/block/${BLOCK}`]);
    await expect(lead(classify(BLOCK), probe)).resolves.toStrictEqual({
      kind: "go",
      path: `/block/${BLOCK}`,
    });
    expect(asked).toStrictEqual([`/block/${BLOCK}`]);
  });

  it("finds a transaction in one request", async () => {
    const { asked, probe } = api([`/tx/${TXID}/status`]);
    await expect(lead(classify(TXID.toUpperCase()), probe)).resolves.toStrictEqual({
      kind: "go",
      path: `/tx/${TXID}`,
    });
    expect(asked).toStrictEqual([`/tx/${TXID}/status`]);
  });

  it("finds a block whose hash looks like a txid in two, never showing the wrong guess", async () => {
    const { asked, probe } = api([`/block/${REGTEST_BLOCK}`]);
    await expect(lead(classify(REGTEST_BLOCK), probe)).resolves.toStrictEqual({
      kind: "go",
      path: `/block/${REGTEST_BLOCK}`,
    });
    expect(asked).toStrictEqual([`/tx/${REGTEST_BLOCK}/status`, `/block/${REGTEST_BLOCK}`]);
  });

  it("says nothing matches when neither exists, after two requests", async () => {
    const { asked, probe } = api([]);
    const query = classify(TXID);
    await expect(lead(query, probe)).resolves.toStrictEqual({ kind: "missing", query });
    expect(asked).toHaveLength(2);
  });

  it("says nothing matches for an unrecognised query without asking", async () => {
    const { asked, probe } = api([]);
    await expect(lead(classify("hello"), probe)).resolves.toStrictEqual({
      kind: "missing",
      query: null,
    });
    expect(asked).toStrictEqual([]);
  });

  it("stops at the first failure that is not a 404: the node being down is not 'nothing'", async () => {
    const asked: string[] = [];
    const down = new ApiError(502, "Upstream unavailable.");
    const probe = (path: string) => {
      asked.push(path);
      return Promise.reject(down);
    };
    await expect(lead(classify(TXID), probe)).rejects.toBe(down);
    expect(asked).toHaveLength(1);
  });
});

describe("createSearch", () => {
  /** A fake fetch whose answers the test releases by hand. */
  function manual() {
    const pending: { path: string; signal: AbortSignal; answer: (found: boolean) => void }[] = [];
    const get: Get = (_network: Network, path, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        pending.push({
          path,
          signal,
          answer: (found) => (found ? resolve({}) : reject(new ApiError(404, "Not found."))),
        });
      });
    return { pending, get };
  }

  it("lets a second search overtake a slow first one", async () => {
    const { pending, get } = manual();
    const search = createSearch(get);
    const first = search.run(TXID, "mainnet");
    const second = search.run(BLOCK, "mainnet");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]?.signal.aborted).toBe(true);
    // The first answers late, and successfully: it must still lose.
    pending[0]?.answer(true);
    pending[1]?.answer(true);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toStrictEqual({ kind: "go", path: `/block/${BLOCK}` });
  });

  it("answers nothing once cancelled", async () => {
    const { pending, get } = manual();
    const search = createSearch(get);
    const run = search.run(TXID, "mainnet");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    search.cancel();
    await expect(run).resolves.toBeUndefined();
  });

  it("reports the node being unavailable as a failure", async () => {
    const down = new ApiError(503, "Node unavailable.");
    const search = createSearch(() => Promise.reject(down));
    await expect(search.run(TXID, "signet")).resolves.toStrictEqual({
      kind: "failed",
      error: down,
    });
  });

  it("asks the network it was given", async () => {
    const seen: Network[] = [];
    const search = createSearch((network) => {
      seen.push(network);
      return Promise.resolve({});
    });
    await search.run(TXID, "testnet4");
    expect(seen).toStrictEqual(["testnet4"]);
  });
});

describe("createSearch and Lightning", () => {
  /** A config with Lightning `on` everywhere or nowhere, and a fake `/app` recording each path;
   * searches wait for `release`. */
  function lightning(on: boolean) {
    const asked: string[] = [];
    const searches: { signal: AbortSignal; release: (v: unknown) => void }[] = [];
    const config = () =>
      Promise.resolve({
        networks: [],
        version: "",
        ark: {},
        lightning: on ? [...NETWORKS] : [],
        broadcast: true,
      });
    const app: Get = (_network, path, signal) => {
      asked.push(path);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        searches.push({ signal, release: resolve });
      });
    };
    return { asked, searches, app, config };
  }
  const nodes = (alias: string) => ({
    nodes: [{ id: KEY, alias, capacity: 5, channels: 1 }],
    channels: [],
  });

  it("opens the results page for a name on Enter, asking the index nothing", async () => {
    const { asked, app, config } = lightning(true);
    const search = createSearch(notFound, app, config);
    await expect(search.run(" noderunner ", "signet")).resolves.toStrictEqual({
      kind: "go",
      path: "/lightning/search?q=noderunner",
    });
    await search.run("acinq", "signet");
    expect(asked).toStrictEqual([]);
  });

  it("says nothing matches a name where Lightning is off, and never searches there", async () => {
    const { asked, app, config } = lightning(false);
    const search = createSearch(notFound, app, config);
    await expect(search.run("noderunner", "mainnet")).resolves.toStrictEqual({
      kind: "missing",
      query: null,
    });
    await expect(search.suggest("noderunner", "mainnet")).resolves.toStrictEqual({
      lightning: false,
      nodes: [],
    });
    expect(asked).toStrictEqual([]);
  });

  it("asks nothing for an id or a query the index refuses", async () => {
    const { asked, app, config } = lightning(true);
    const search = createSearch(notFound, app, config);
    for (const q of [TXID, KEY, "811984x2037x0", "840000", "ab", "x".repeat(67)]) {
      await expect(search.suggest(q, "signet")).resolves.toStrictEqual({
        lightning: undefined,
        nodes: [],
      });
    }
    expect(asked).toStrictEqual([]);
  });

  it("suggests nodes with their names cleaned, and a newer suggestion overtakes an older", async () => {
    const { searches, app, config } = lightning(true);
    const search = createSearch(notFound, app, config);
    const first = search.suggest("node", "signet");
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    const second = search.suggest("noderunner", "signet");
    await vi.waitFor(() => expect(searches).toHaveLength(2));
    expect(searches[0]?.signal.aborted).toBe(true);
    searches[0]?.release(nodes("old"));
    searches[1]?.release(nodes("bad\u{202E}name"));
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toStrictEqual({
      lightning: true,
      nodes: [{ key: KEY, name: "bad\u{FFFD}name", capacity: 5, path: `/lightning/node/${KEY}` }],
    });
  });

  it("answers nothing once cancelled, and offers nothing when the search fails", async () => {
    const { searches, app, config } = lightning(true);
    const search = createSearch(notFound, app, config);
    const cancelled = search.suggest("noderunner", "signet");
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    search.cancel();
    await expect(cancelled).resolves.toBeUndefined();
    const failing = createSearch(
      notFound,
      () => Promise.reject(new ApiError(503, "Syncing.")),
      config,
    );
    await expect(failing.suggest("noderunner", "signet")).resolves.toStrictEqual({
      lightning: true,
      nodes: [],
    });
  });
});

describe("payment strings", () => {
  it("go to the one decoder, the string in the fragment, without asking anything", async () => {
    const { asked, probe } = api([]);
    await expect(lead(classify("satoshi@bitcoin.org"), probe)).resolves.toStrictEqual({
      kind: "go",
      path: "/decode#satoshi%40bitcoin.org",
    });
    expect(asked).toStrictEqual([]);
    expect(read("lnurlp://pay.example.com/x", "signet")).toStrictEqual({
      label: "LNURL",
      ready: true,
    });
  });
});
