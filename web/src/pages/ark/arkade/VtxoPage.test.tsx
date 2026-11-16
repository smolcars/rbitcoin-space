import { createRouter, memoryHistory } from "@solidjs/router";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiCache } from "../../../lib/api";
import { FakeSocket } from "../../../lib/fakes";
import { A, answer, C, K, NOW } from "./testdata";
import type { VtxoAnswer } from "./vtxo";
import VtxoPage from "./VtxoPage";

// The shell's config, as the server would give it: Arkade on signet unless a test says otherwise.
const ark = vi.hoisted(() => ({ signet: ["arkade"] }));
vi.mock(import("../../../lib/config"), () => ({
  loadConfig: async () => ({
    networks: ["signet"],
    version: "1",
    ark: { signet: ark.signet },
    lightning: [],
    broadcast: false,
  }),
}));

let reply: () => Response;
let requests: string[];
const disposers: (() => void)[] = [];

beforeEach(() => {
  clearApiCache();
  ark.signet = ["arkade"];
  requests = [];
  reply = () => Response.json(answer());
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    return reply();
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(path: string): HTMLElement {
  const Router = createRouter({
    routes: [
      {
        path: ["/", "/signet"],
        children: [{ path: "/ark/arkade/vtxo/:outpoint", component: VtxoPage }],
      },
    ],
    history: memoryHistory(path),
  });
  const el = document.createElement("div");
  document.body.append(el);
  disposers.push(render(() => <Router>{(page) => page.children}</Router>, el));
  return el;
}

const text = (el: HTMLElement) => (el.textContent ?? "").replaceAll(" ", " ");
const shows = async (el: HTMLElement, s: string) => vi.waitFor(() => expect(text(el)).toContain(s));
const page = `/signet/ark/arkade/vtxo/${A}:0`;

describe("an Arkade VTXO", () => {
  it("answers first: its status, amount, expiry and exit", async () => {
    const el = open(page);
    await shows(el, "Transactions");
    expect(requests).toStrictEqual([`/signet/app/ark/arkade/vtxo/${A}/0`]);
    const badges = [...el.querySelectorAll(".arkade-badge")].map((b) => b.textContent);
    expect(badges).toStrictEqual(["Unspent", "Not settled yet"]);
    expect(text(el)).toContain("150 000 sats");
    expect(text(el)).toContain("22 days left");
    expect(text(el)).toContain("5 transactions");
    expect(text(el)).toContain("3 tree, 1 checkpoint, 1 transfer");
    expect(text(el)).toContain(`${A.slice(56)}:0`);
  });

  it("lists the exit in broadcast order, linking only what is on chain", async () => {
    const el = open(page);
    await shows(el, "Transactions");
    const rows = [...el.querySelectorAll("tbody tr")].map((r) =>
      [...r.querySelectorAll("td")].slice(0, 3).map((c) => text(c as HTMLElement).trim()),
    );
    expect(rows).toStrictEqual([
      ["–", "Commitment", "Confirmed 274 022"],
      ["1", "Branch tree", "Off chain"],
      ["2", "Branch tree", "Off chain"],
      ["3", "Leaf tree", "Off chain"],
      ["4", "Checkpoint", "Off chain"],
      ["5", "Transfer ark", "Off chain"],
    ]);
    const hrefs = [...el.querySelectorAll("tbody a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`/signet/tx/${C}`);
    expect(hrefs).toContain("/signet/block/274022");
    expect(hrefs.some((h) => h?.includes(K))).toBe(false);
  });

  it("draws the tree with this VTXO's way out, and shows a transaction picked in it", async () => {
    const el = open(page);
    await shows(el, "This VTXO");
    const nodes = el.querySelectorAll(".arkade-node");
    // Commitment, three tree transactions, the checkpoint and the transfer.
    expect(nodes).toHaveLength(6);
    expect(el.querySelectorAll(".arkade-link--mine")).toHaveLength(5);
    expect(el.querySelectorAll(".arkade-dot--leaf")).toHaveLength(3);
    const checkpoint = el.querySelector(`[aria-label="4. Checkpoint"]`);
    checkpoint?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();
    const pick = el.querySelector(".arkade-pick");
    expect(text(pick as HTMLElement)).toContain("#4 Checkpoint");
    expect(pick?.querySelector(`[title="${K}"]`)).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flush();
    expect(el.querySelector(".arkade-pick")).toBeNull();
  });

  it("plays the exit to its end, the wait after it, in a still picture under reduced motion", async () => {
    const el = open(page);
    await shows(el, "This VTXO");
    const play = [...el.querySelectorAll("button")].find((b) => b.textContent === "Play exit");
    play?.click();
    flush();
    expect(text(el)).toContain("then wait ~2 days");
  });

  it("keeps the time left on the picture near the expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue((answer().vtxo.expires_at - 60) * 1000);
    const el = open(page);
    await shows(el, "1 min left");
    const label = [...el.querySelectorAll(".arkade-axis text")].find(
      (t) => t.textContent === "1 min left",
    );
    expect(label?.getAttribute("text-anchor")).toBe("end");
  });

  it("says when it was swept, and shows its exit as expired", async () => {
    const swept: VtxoAnswer = answer();
    swept.vtxo.swept = true;
    reply = () => Response.json(swept);
    const el = open(page);
    await shows(el, "Transactions");
    expect([...el.querySelectorAll(".arkade-badge")].map((b) => b.textContent)).toStrictEqual([
      "Swept",
    ]);
    expect(text(el)).toContain("Expired");
  });
});

describe("states without a VTXO", () => {
  it("names a malformed outpoint and asks nothing", async () => {
    const el = open("/signet/ark/arkade/vtxo/not-an-outpoint");
    await shows(el, "Not a VTXO");
    expect(requests).toHaveLength(0);
  });

  it("says Arkade knows no such VTXO", async () => {
    reply = () => Response.json({ error: "vtxo not found" }, { status: 404 });
    const el = open(page);
    await shows(el, "Arkade knows no such VTXO");
    expect(el.querySelector(".arkade-svg")).toBeNull();
  });

  it("says Arkade is not available on a network without it, and asks nothing", async () => {
    ark.signet = ["bark"];
    const el = open(page);
    await shows(el, "Arkade is not available on this network");
    expect(requests).toHaveLength(0);
    expect(el.querySelector("a[href='/signet/ark']")?.textContent).toContain("Another VTXO");
  });

  it("says so too when the server has no Arkade after all", async () => {
    reply = () => Response.json({ error: "arkade is not available here" }, { status: 404 });
    const el = open(page);
    await shows(el, "Arkade is not available on this network");
    expect(requests).toHaveLength(1);
  });

  it("says Arkade is not answering, with a retry", async () => {
    reply = () => Response.json({ error: "arkade is not answering" }, { status: 502 });
    const el = open(page);
    await shows(el, "Arkade is not answering");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(
      true,
    );
  });

  it("does not show an answer it cannot read", async () => {
    reply = () => Response.json({ ...answer(), chain: [{ txid: "<b>x</b>" }] });
    const el = open(page);
    await shows(el, "Arkade is not answering");
    expect(el.querySelector("b")).toBeNull();
  });
});
