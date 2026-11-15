import { createSignal, flush } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";
import { KINDS, NO_PICK, pick, setPick } from "../lib/goggles";
import { Goggles } from "./Goggles";
import { mount } from "./test-utils";

const bit = (key: string) => 2 ** (KINDS.find((k) => k.key === key)?.bit ?? 60);
// Taproot twice, one an inscription; one OP_RETURN; no consolidation at all.
const BLOCK = [
  { vsize: 100, flags: bit("taproot") + bit("inscription") },
  { vsize: 300, flags: bit("taproot") },
  { vsize: 600, flags: bit("op-return") },
];

function setup(txs = BLOCK) {
  const [block, setBlock] = createSignal<typeof BLOCK | undefined>(txs);
  const el = mount(() => <Goggles txs={block()} frame={() => undefined} />);
  flush();
  const q = (s: string) => {
    const found = el.querySelector<HTMLElement>(s);
    if (!found) throw new Error(`no ${s}`);
    return found;
  };
  const button = (s: string) => {
    const found = q(s);
    if (!(found instanceof HTMLButtonElement)) throw new TypeError(`${s} is not a button`);
    return found;
  };
  const toggle = button(".gg__toggle");
  const chip = (label: string) => {
    const found = [...el.querySelectorAll<HTMLButtonElement>(".gg__chip")].find(
      (c) => c.querySelector(".gg__label")?.textContent === label,
    );
    if (!found) throw new Error(`no chip ${label}`);
    return found;
  };
  const press = (b: HTMLElement) => {
    b.click();
    flush();
  };
  const status = () => q(".gg [role=status]").textContent;
  const result = () => el.querySelector(".gg__result")?.textContent ?? "";
  return { el, q, button, toggle, chip, press, status, result, setBlock };
}

const key = (k: string) => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  flush();
};

beforeEach(() => {
  setPick(NO_PICK);
  sessionStorage.clear();
});

describe("Goggles", () => {
  it("opens from its button, focusing the first kind, and closes with Escape back to it", async () => {
    const g = setup();
    expect(g.toggle.getAttribute("aria-expanded")).toBe("false");
    g.toggle.focus();
    g.press(g.toggle);
    expect(g.toggle.getAttribute("aria-expanded")).toBe("true");
    await Promise.resolve();
    expect(document.activeElement).toBe(g.chip("Taproot"));
    key("Escape");
    expect(g.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(g.toggle);
  });

  it("closes with Done, back to its button", () => {
    const g = setup();
    g.press(g.toggle);
    g.press(g.q(".gg__done"));
    expect(g.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(g.toggle);
  });

  it("waits for the block before it can open", () => {
    const g = setup();
    g.setBlock(undefined);
    flush();
    expect(g.toggle.disabled).toBe(true);
  });

  it("shows each kind's share, a kind absent from the block dashed and not picked", () => {
    const g = setup();
    expect(g.chip("Taproot").textContent).toContain("40%");
    expect(g.chip("Taproot").style.getPropertyValue("--share")).toBe("0.4");
    const none = g.chip("Consolidation");
    expect(none.getAttribute("aria-disabled")).toBe("true");
    expect(none.classList.contains("gg__chip--dashed")).toBe(true);
    expect(none.textContent).toContain("none here");
    g.press(none);
    expect(pick().kinds).toStrictEqual([]);
  });

  it("picks a kind: a tag, the result in one line, said once, and remembered for the visit", () => {
    const g = setup();
    g.press(g.chip("Taproot"));
    expect(g.chip("Taproot").getAttribute("aria-pressed")).toBe("true");
    expect(g.q(".gg__tag").textContent).toBe("Taproot");
    expect(g.result()).toBe("2 of 3 · 40% of the block");
    expect(g.status()).toBe("2 of 3 · 40% of the block");
    expect(JSON.parse(sessionStorage.getItem("goggles") ?? "")).toStrictEqual({
      kinds: ["taproot"],
      mode: "any",
    });
    // Another map, on another page, starts with the same pick.
    const again = setup();
    expect(again.chip("Taproot").getAttribute("aria-pressed")).toBe("true");
  });

  it("follows a live block without a word, and never moves a chip's share", () => {
    const g = setup();
    g.press(g.chip("Taproot"));
    const said = g.status();
    g.setBlock([...BLOCK, { vsize: 1000, flags: bit("taproot") }]);
    flush();
    expect(g.result()).toBe("3 of 4 · 70% of the block");
    expect(g.status()).toBe(said);
  });

  it("joins kinds with or, and in All mode dashes a kind that would leave nothing lit", () => {
    const g = setup();
    expect(g.el.querySelector(".gg__mode")).toBeNull();
    g.press(g.chip("Taproot"));
    g.press(g.chip("Inscription"));
    expect(g.q(".gg__join").textContent).toBe("or");
    expect(g.result()).toBe("2 of 3 · 40% of the block");
    expect(g.chip("OP_RETURN").classList.contains("gg__chip--dashed")).toBe(false);
    const all = [...g.q(".gg__mode").querySelectorAll("button")].find(
      (b) => b.textContent === "All",
    );
    if (!all) throw new Error("no All");
    g.press(all);
    expect(g.q(".gg__join").textContent).toBe("and");
    expect(g.result()).toBe("1 of 3 · 10% of the block");
    expect(g.status()).toBe("1 of 3 · 10% of the block");
    const dead = g.chip("OP_RETURN");
    expect(dead.classList.contains("gg__chip--dashed")).toBe(true);
    expect(dead.textContent).toContain("none with the picked kinds");
    // Still pickable: it says what it would do, it does not refuse.
    expect(dead.getAttribute("aria-disabled")).toBeNull();
    g.press(dead);
    expect(g.result()).toBe("None of 3");
  });

  it("takes a kind out from its tag and clears from the panel, focus kept in the control", () => {
    const g = setup();
    g.press(g.toggle);
    g.press(g.chip("Taproot"));
    g.press(g.chip("OP_RETURN"));
    g.press(g.q(".gg__tag"));
    expect(pick().kinds.map((k) => k.key)).toStrictEqual(["op-return"]);
    expect(document.activeElement).toBe(g.toggle);
    g.press(g.q(".gg__clear"));
    expect(pick().kinds).toStrictEqual([]);
    expect(g.el.querySelector(".gg__result")).toBeNull();
    expect(document.activeElement).toBe(g.chip("Taproot"));
  });

  it("opens the rest of the kinds in groups, keeping its button", () => {
    const g = setup();
    const more = g.button(".gg__more");
    expect(more.textContent).toContain(String(KINDS.length - 5));
    expect(g.el.querySelectorAll(".gg__chip")).toHaveLength(5);
    g.press(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(g.el.querySelectorAll(".gg__chip")).toHaveLength(KINDS.length);
    expect(
      [...g.el.querySelectorAll(".gg__group")].map((x) => x.getAttribute("aria-label")),
    ).toStrictEqual(["Common kinds", "Scripts", "Other", "Version and RBF", "Signature hash"]);
  });
});
