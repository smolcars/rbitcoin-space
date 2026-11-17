import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import DecodePage from "./DecodePage";
import { isDecoded, readFragment, splitHost } from "./decode";
import { ANSWERS } from "./testdata";

let reply: () => Response;
/** What a service other than ours answers, by URL. */
let services: Record<string, () => Response>;
let sent: { url: string; method: string | undefined; body: unknown }[];

beforeEach(() => {
  clearApiCache();
  sent = [];
  reply = () => Response.json(ANSWERS.bolt11);
  services = {};
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, body: init?.body });
    return (services[url] ?? reply)();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (el: HTMLElement) => (el.textContent ?? "").replaceAll(" ", " ");
const shows = async (el: HTMLElement, s: string) => vi.waitFor(() => expect(text(el)).toContain(s));
const open = (pasted: string) =>
  mount(() => <DecodePage />, `/decode#${encodeURIComponent(pasted)}`);
const json =
  (v: unknown, status = 200) =>
  () =>
    Response.json(v, { status });

describe("the decoder page", () => {
  it("is a box and a line when nothing is pasted, and asks nothing", async () => {
    const el = mount(() => <DecodePage />, "/decode");
    await shows(el, "Raw transactions");
    expect(el.querySelector("textarea")).not.toBeNull();
    expect(sent).toStrictEqual([]);
  });

  it("checks raw transaction hex on the server's first network and draws it there", async () => {
    const txid = "fc40c92d9763e584976a4c55b50b231c214f2a5ae0514dadc8e1bf0958d68fa6";
    const output = {
      scriptpubkey: "0014",
      scriptpubkey_asm: "OP_0",
      scriptpubkey_type: "v0_p2wpkh",
      scriptpubkey_address: "tb1qexample",
      value: 4_999_999_000,
    };
    const tx = {
      txid,
      version: 2,
      locktime: 0,
      vin: [
        {
          txid,
          vout: 0,
          prevout: { ...output, value: 5_000_000_000 },
          scriptsig: "",
          witness: ["51"],
          is_coinbase: false,
          sequence: 4_294_967_293,
        },
      ],
      vout: [output],
      size: 99,
      weight: 381,
      fee: 1000,
      status: { confirmed: false },
    };
    services["/app/config"] = json({ networks: ["signet", "mainnet"], broadcast: true });
    services["/signet/app/tx/check"] = json({ tx, known: null });
    const el = open("02AB\ncd");
    await shows(el, "Inputs and outputs");
    expect(sent.find((r) => r.url.endsWith("/tx/check"))).toStrictEqual({
      url: "/signet/app/tx/check",
      method: "POST",
      body: "02abcd",
    });
    expect(sent.some((r) => r.url === "/app/decode")).toBe(false);
    expect(text(el)).toContain("Transaction");
    expect(text(el)).toContain("Signet");
    // No broadcast button: a link to the broadcast page, the hex in history state, not the URL.
    expect(el.querySelector(".push-send")).toBeNull();
    const to = [...el.querySelectorAll("a")].find((a) => a.textContent === "Broadcast");
    expect(to?.getAttribute("href")).toBe("/signet/tx/push");
    expect(to?.getAttribute("state")).toBe('{"hex":"02abcd"}');
    // The flow's links stay on the network it was checked on.
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/signet/address/tb1qexample");
  });

  it("says hex that is no transaction is not one", async () => {
    services["/app/config"] = json({ networks: ["signet"], broadcast: false });
    services["/signet/app/tx/check"] = json(
      { error: "body must be one raw transaction in hex" },
      400,
    );
    const el = open("abcd");
    await shows(el, "Hex, but not a transaction");
    expect(el.querySelector(".push-result")).toBeNull();
  });

  it("sends the fragment's string in a POST body to the one route, never in the URL", async () => {
    const el = open("lightning:LNBC20M1PVJ");
    await shows(el, "Lightning invoice");
    expect(sent).toStrictEqual([
      { url: "/app/decode", method: "POST", body: "lightning:LNBC20M1PVJ" },
    ]);
    expect(el.querySelector("textarea")?.value).toBe("lightning:LNBC20M1PVJ");
  });

  it("reads an invoice: amount, network, hints linked to the graph that named them", async () => {
    const el = open("lnbc20m1x");
    await shows(el, "2 000 000 sats");
    expect(text(el)).toContain("Mainnet");
    expect(text(el)).toContain("Expired");
    expect(text(el)).toContain("Payee, from the signature");
    expect(text(el)).toContain("20 ppm + 1 msat, 3 blocks");
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(
      "/lightning/node/029e03a901b85534ff1e92c43c74431f7ce72046060fcf7a95c37e148f78c77255",
    );
    expect(hrefs).toContain("/lightning/channel/66051x263430x1800");
    // The second hop is unknown: its key and channel are text, with copy buttons.
    expect(hrefs).not.toContain("/lightning/channel/197637x395016x2314");
    expect(text(el)).toContain("197637x395016x2314");
    // A name is text, never markup.
    expect(text(el)).toContain("Hint <b>one</b>");
    expect(el.querySelector("b")).toBeNull();
    expect(text(el)).toContain("Names from this server's Mainnet graph.");
  });

  it("links a signet string's keys to signet's pages", async () => {
    reply = json({ ...ANSWERS.bolt11, network: "signet", names: "signet" });
    const el = open("lntbs1x");
    await shows(el, "Signet");
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/signet/lightning/channel/66051x263430x1800");
  });

  it("names nothing and links nothing without a graph", async () => {
    reply = json(ANSWERS.bolt11_plain);
    const el = open("lnbc1x");
    await shows(el, "Please consider supporting this project");
    expect(text(el)).toContain("Any amount");
    expect(el.querySelectorAll("a[href*='lightning']")).toHaveLength(0);
  });

  it("reads an offer with blinded paths, and one priced in a currency", async () => {
    reply = json(ANSWERS.offer);
    const el = open("lno1x");
    await shows(el, "Lightning offer");
    expect(text(el)).toContain("Blinded paths");
    expect(text(el)).toContain("end 2");
    expect(text(el)).toContain("blinded, 2 hops");
    reply = json(ANSWERS.offer_currency);
    const other = open("lno1y");
    await shows(other, "10 000 USD");
    expect(text(other)).toContain("About the amount");
  });

  it("reads an LNURL: its host set apart, the URL as text and never a link", async () => {
    reply = json(ANSWERS.lnurl);
    const el = open("LNURL1X");
    await shows(el, "LNURL");
    expect(text(el)).toContain("Any network");
    expect(el.querySelector(".dec-url__host")?.textContent).toBe("service.com");
    expect(el.querySelector("a[href^='http']")).toBeNull();
    reply = json(ANSWERS.lnurl_withdraw);
    await shows(open("lnurlw://x"), "LNURL withdraw");
  });

  it("reads a Lightning address and the URL it maps to", async () => {
    reply = json(ANSWERS.lightning_address);
    const el = open("satoshi@bitcoin.org");
    await shows(el, "Lightning address");
    expect(text(el)).toContain("https://bitcoin.org/.well-known/lnurlp/satoshi");
  });

  it("reads Arkade and Bark addresses", async () => {
    reply = json(ANSWERS.arkade);
    const el = open("tark1x");
    await shows(el, "Arkade address");
    expect(text(el)).toContain("Test network");
    reply = json(ANSWERS.bark);
    const bark = open("ark1x");
    await shows(bark, "Bark address");
    expect(text(bark)).toContain("Mailbox");
  });

  it.each([
    [400, "bad checksum", "The checksum fails"],
    [400, "bad signature", "The signature does not verify"],
    [400, "not recognised", "Not an invoice, offer, LNURL or address"],
    [400, "malformed", "It does not follow its format's rules"],
    [413, "too long", "Too long to be a payment string"],
  ])("says a %i %s in one line", async (status, error, said) => {
    reply = json({ error }, status);
    const el = open("lnbc1x");
    await shows(el, said);
    expect(el.querySelector("button[type=button]")).toBeNull();
  });

  it("offers a retry when the server cannot be reached", async () => {
    reply = () => {
      throw new TypeError("network down");
    };
    const el = open("lnbc1x");
    await shows(el, "Could not decode");
    reply = json(ANSWERS.bolt11);
    const retry = [...el.querySelectorAll("button")].find((b) =>
      /again/i.test(b.textContent ?? ""),
    );
    expect(retry).toBeDefined();
    retry?.click();
    await shows(el, "2 000 000 sats");
  });

  it("refuses an answer of the wrong shape", async () => {
    reply = json({ kind: "bolt11", network: "mainnet", names: null });
    const el = open("lnbc1x");
    await shows(el, "Could not decode");
    expect(text(el)).not.toContain("sats");
  });

  // A clock read while building controls once replaced them every second.
  it("follows the clock in the expiry text only, keeping every control", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const created = ANSWERS.bolt11.created;
    vi.setSystemTime((created + 3600 - 120) * 1000);
    const el = open("lnbc20m1x");
    await shows(el, "Expires in 2 min");
    const button = el.querySelector(".copy, button[aria-label^='Copy']");
    const link = el.querySelector("a");
    expect(button).not.toBeNull();
    vi.advanceTimersByTime(180_000);
    flush();
    await shows(el, "Expired 1 min ago");
    expect(button?.isConnected).toBe(true);
    expect(link?.isConnected).toBe(true);
  });
});

describe("asking the service an LNURL names", () => {
  const PAY = {
    tag: "payRequest",
    callback: "https://evil.example/cb?amount=",
    minSendable: 1000,
    maxSendable: 21_000_000,
    metadata: JSON.stringify([["text/plain", "<img src=x onerror=alert(1)>"]]),
  };

  it("asks the URL once, shows the answer as text, and never calls the callback", async () => {
    reply = json(ANSWERS.lnurl);
    const url = (ANSWERS.lnurl as { url: string }).url;
    services[url] = json(PAY);
    const el = open("LNURL1X");
    await shows(el, "From the service");
    await shows(el, "1 – 21 000 sats");
    expect(text(el)).toContain("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
    expect(text(el)).toContain("Other host");
    expect(sent.map((r) => r.url)).toStrictEqual(["/app/decode", url]);
  });

  it("stops asking when the box is edited, and asks again when it holds the string again", async () => {
    reply = json(ANSWERS.lightning_address);
    const url = "https://bitcoin.org/.well-known/lnurlp/satoshi";
    let aborted = 0;
    vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
      sent.push({ url: u, method: init?.method, body: init?.body });
      if (u !== url) return Promise.resolve(reply());
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted += 1;
          reject(new DOMException("", "AbortError"));
        });
      });
    });
    const el = open("satoshi@bitcoin.org");
    await shows(el, "Asking bitcoin.org");
    const box = el.querySelector("textarea") as HTMLTextAreaElement;
    box.value = "satoshi@bitcoin.or";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(aborted).toBe(1));
    expect(text(el)).not.toContain("From the service");
    box.value = "satoshi@bitcoin.org";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await shows(el, "Asking bitcoin.org");
    expect(sent.filter((r) => r.url === url)).toHaveLength(2);
  });

  it("never asks a login link", async () => {
    reply = json({ ...ANSWERS.lnurl, tag: "login", k1: "00" });
    const el = open("keyauth://x");
    await shows(el, "LNURL login");
    expect(text(el)).not.toContain("From the service");
    expect(sent.map((r) => r.url)).toStrictEqual(["/app/decode"]);
  });

  it("says what failed in one line", async () => {
    reply = json(ANSWERS.lightning_address);
    services["https://bitcoin.org/.well-known/lnurlp/satoshi"] = () => {
      throw new TypeError("Failed to fetch");
    };
    const el = open("satoshi@bitcoin.org");
    await shows(el, "Could not ask bitcoin.org");
    expect(el.querySelectorAll(".dec-section")).toHaveLength(1);
  });
});

describe("decode helpers", () => {
  it("every recorded answer is one the page draws", () => {
    for (const a of Object.values(ANSWERS)) expect(isDecoded(a)).toBe(true);
  });

  it("round-trips the fragment", () => {
    const s = "LNURL1DP68 + x#y%z@é";
    expect(readFragment(`#${encodeURIComponent(s)}`)).toBe(s);
    expect(readFragment("#%E0%A4%A")).toBe("");
  });

  it("sets the host apart from user info, a port and the path", () => {
    expect(splitHost("https://user@site.example:8443/a?b", "site.example")).toStrictEqual([
      "https://user@",
      "site.example",
      ":8443/a?b",
    ]);
    // The look-alike's own host, not the name it borrows in its path.
    expect(splitHost("https://evil.example/site.example", "evil.example")[1]).toBe("evil.example");
    expect(splitHost("https://SITE.example/", "site.example")[1]).toBe("SITE.example");
  });
});
