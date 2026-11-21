import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Scanner from "./Scanner";

// The decoder is stood in for: what it reads is set per test. The real ones are in decode.test.ts
// and the browser tests (e2e/scan.e2e.ts).
const read = vi.hoisted(() => ({ text: null as string | null, fails: false }));
vi.mock(import("./decode"), async (original) => ({
  ...(await original()),
  createDecoder: () =>
    Promise.resolve({
      kind: "jsqr" as const,
      attempts: 1,
      detect: () =>
        read.fails ? Promise.reject(new Error("no reader")) : Promise.resolve(read.text),
    }),
}));

/** A camera stream of one track, whose `stop` is recorded. */
function fakeStream() {
  const track = {
    stop: vi.fn<() => void>(),
    getSettings: () => ({ facingMode: "environment" }),
    addEventListener: vi.fn<() => void>(),
  };
  // A MediaStream, as a video's srcObject takes nothing else, with the track put in its place.
  const stream = Object.assign(new MediaStream(), {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  });
  return { stream, track };
}

/** `getUserMedia` answering as the test says, when it says: the latest request, or the `n`th. */
function camera() {
  const answers: { resolve: (s: MediaStream) => void; reject: (e: unknown) => void }[] = [];
  const getUserMedia = vi.fn<() => Promise<MediaStream>>(
    () =>
      new Promise<MediaStream>((resolve, reject) => {
        answers.push({ resolve, reject });
      }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  return {
    getUserMedia,
    grant: (s: MediaStream, n = answers.length - 1) => answers[n]?.resolve(s),
    refuse: (name: string) => answers.at(-1)?.reject(new DOMException("", name)),
  };
}

function open() {
  const onResult = vi.fn<(text: string) => void>();
  const onClose = vi.fn<() => void>();
  const el = document.createElement("div");
  document.body.append(el);
  const dispose = render(() => <Scanner onResult={onResult} onClose={onClose} />, el);
  flush();
  const status = () => el.querySelector('[role="status"]')?.textContent ?? "";
  const button = (name: string) =>
    [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  return { el, onResult, onClose, dispose, status, button };
}

const settle = async (check: () => void) =>
  vi.waitFor(() => {
    flush();
    check();
  });

beforeEach(() => {
  read.text = null;
  read.fails = false;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Scanner", () => {
  it("is a dialog named for what it does, offering a picture from the start", () => {
    camera();
    const { el, status, button, dispose } = open();
    const dialog = el.querySelector("dialog");
    const title = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(title)?.textContent).toBe("Scan a QR code");
    expect(status()).toBe("Starting the camera…");
    expect(button("Choose a picture")).toBeDefined();
    dispose();
  });

  it("says a blocked camera is blocked, and offers a picture and another try", async () => {
    const { refuse, getUserMedia } = camera();
    const { status, button, dispose } = open();
    refuse("NotAllowedError");
    await settle(() => expect(status()).toMatch(/blocked for this site/));
    expect(button("Choose a picture")).toBeDefined();
    button("Try again")?.click();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("says when there is no camera, with no try again that would fail the same way", async () => {
    const { refuse } = camera();
    const { status, button, dispose } = open();
    refuse("NotFoundError");
    await settle(() => expect(status()).toMatch(/No camera found/));
    expect(button("Try again")).toBeUndefined();
    dispose();
  });

  it("turns the camera off when it closes", async () => {
    const { grant } = camera();
    const { status, dispose } = open();
    const { stream, track } = fakeStream();
    grant(stream);
    await settle(() => expect(status()).toBe("Hold the code inside the frame."));
    expect(track.stop).not.toHaveBeenCalled();
    dispose();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("turns off a camera the browser grants after the scanner closed", async () => {
    const { grant } = camera();
    const { dispose } = open();
    dispose();
    const { stream, track } = fakeStream();
    grant(stream);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  });

  it("asks to close on Escape (the dialog's cancel)", () => {
    camera();
    const { el, onClose, dispose } = open();
    el.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    dispose();
  });

  /** Chooses a picture in the scanner, its code reading as `text`. */
  const choosePicture = (el: HTMLElement, text: string | null) => {
    read.text = text;
    const input = el.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "code.png", { type: "image/png" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
  };

  it("turns off a camera granted to a request that a newer one replaced", async () => {
    const { grant, getUserMedia } = camera();
    const { el, status, button, dispose } = open();
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 4, height: 4, close() {} }));
    // A picture whose reader fails offers Try again while the first request is still asked.
    read.fails = true;
    choosePicture(el, null);
    await settle(() => expect(button("Try again")).toBeDefined());
    button("Try again")?.click();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    const first = fakeStream();
    const second = fakeStream();
    grant(second.stream, 1);
    await settle(() => expect(status()).toBe("Hold the code inside the frame."));
    grant(first.stream, 0);
    await vi.waitFor(() => expect(first.track.stop).toHaveBeenCalledOnce());
    dispose();
    expect(second.track.stop).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("lets nothing cancel a code it has read, and offers no try again meanwhile", async () => {
    document.documentElement.style.setProperty("--dur-base", "60ms");
    const { refuse } = camera();
    const { el, button, onResult, dispose } = open();
    refuse("NotAllowedError");
    await settle(() => expect(button("Try again")).toBeDefined());
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 4, height: 4, close() {} }));
    choosePicture(el, "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    await settle(() => expect(button("Try again")).toBeUndefined());
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    document.documentElement.style.removeProperty("--dur-base");
    vi.unstubAllGlobals();
    dispose();
  });

  it("drops a failed reader's message once a picture is read again", async () => {
    const { refuse } = camera();
    const { el, status, dispose } = open();
    refuse("NotFoundError");
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 4, height: 4, close() {} }));
    read.fails = true;
    choosePicture(el, null);
    await settle(() => expect(status()).toMatch(/The code reader did not load/));
    read.fails = false;
    choosePicture(el, null);
    await settle(() => expect(status()).toMatch(/No QR code found/));
    vi.unstubAllGlobals();
    dispose();
  });

  it("answers only for the latest picture chosen", async () => {
    const { refuse } = camera();
    const { el, status, onResult, dispose } = open();
    refuse("NotFoundError");
    const pending: ((b: unknown) => void)[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const bitmap = { width: 4, height: 4, close() {} };
    // The first picture is being opened when the second is chosen.
    choosePicture(el, null);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    choosePicture(el, null);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.(bitmap);
    await settle(() => expect(status()).toMatch(/No QR code found/));
    // The first picture, read last, holds a code: it was replaced, so it opens nothing.
    read.text = "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    pending[0]?.(bitmap);
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    flush();
    expect(onResult).not.toHaveBeenCalled();
    expect(status()).toMatch(/No QR code found/);
    vi.unstubAllGlobals();
    dispose();
  });

  it("opens no picture once the scanner closed while its reader downloaded", async () => {
    camera();
    const { el, dispose } = open();
    const opened = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ width: 4, height: 4, close() {} }),
    );
    vi.stubGlobal("createImageBitmap", opened);
    choosePicture(el, null);
    dispose();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(opened).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reads a chosen picture, and hands on what its code holds", async () => {
    const { refuse } = camera();
    const { el, status, onResult, dispose } = open();
    refuse("NotFoundError");
    const close = vi.fn<() => void>();
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 4, height: 4, close }));
    const choose = (text: string | null) => choosePicture(el, text);
    choose(null);
    await settle(() => expect(status()).toMatch(/No QR code found in that picture/));
    expect(onResult).not.toHaveBeenCalled();
    choose("bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    await settle(() =>
      expect(onResult).toHaveBeenCalledWith("bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"),
    );
    expect(close).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    dispose();
  });
});
