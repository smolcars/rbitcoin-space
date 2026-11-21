// The editor's code held while it downloads: what the reader does meanwhile decides whether it opens.
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../test-utils";
import { LabelControl } from "./Label";

const download = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
});

vi.mock(import("./LabelEditor"), async (actual) => {
  await download.held;
  return actual();
});

const TXID = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";

describe("the editor while it downloads", () => {
  it("Escape while the editor downloads gives the opening up: it never opens or takes focus", async () => {
    const el = mount(() => (
      <>
        <LabelControl type="tx" reference={TXID} what="this transaction" />
        <a href="#elsewhere">elsewhere</a>
      </>
    ));
    flush();
    const button = el.querySelector<HTMLButtonElement>(".label-control__open");
    button?.focus();
    button?.click();
    // The reader gives up and moves on.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const elsewhere = el.querySelector<HTMLAnchorElement>("a");
    elsewhere?.focus();
    download.release();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    flush();
    expect(el.querySelector(".label-pop")).toBeNull();
    expect(el.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    // A press afterwards opens it as usual.
    button?.click();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    flush();
    expect(el.querySelector(".label-pop")).not.toBeNull();
  });
});
