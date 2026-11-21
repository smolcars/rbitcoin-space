// The page's choices against reads that finish out of order (review round 1, T4): every result
// belongs to the choice that started it, and a later choice or a removal makes earlier ones moot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import { hash } from "./hashes";
import TimestampPage from "./TimestampPage";
import { ATT, writeProof } from "./testdata";

beforeEach(() => {
  clearApiCache();
  vi.stubGlobal("fetch", () =>
    Promise.resolve(Response.json({ networks: ["mainnet"], version: "0" })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, resolve: open };
}

/** A file whose bytes arrive only when `gate` opens, whole or by slices. */
function fakeFile(name: string, bytes: Uint8Array, gate?: Promise<void>): File {
  const read = (part: Uint8Array) => () =>
    (gate ?? Promise.resolve()).then(() => new Uint8Array(part).buffer);
  return {
    name,
    size: bytes.length,
    arrayBuffer: read(bytes),
    slice: (a?: number, b?: number) => ({ arrayBuffer: read(bytes.slice(a, b)) }),
  } as unknown as File;
}

function choose(input: Element | undefined, file: File) {
  if (!(input instanceof HTMLInputElement)) throw new TypeError("no input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const text = (el: HTMLElement) => el.textContent ?? "";
const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
const content = new TextEncoder().encode("the file\n");
const pendingProof = writeProof(hash("sha256", content), {
  att: [ATT.pending("https://alice.btc.calendar.opentimestamps.org")],
});
const open = () => {
  const el = mount(() => <TimestampPage />, "/timestamp");
  const inputs = [...el.querySelectorAll('input[type="file"]')];
  return { el, proof: inputs[0], file: inputs[1] };
};

describe("choices that finish out of order", () => {
  it("never lets an earlier proof's slower read replace a later choice", async () => {
    const { el, proof, file } = open();
    const slow = deferred();
    choose(proof, fakeFile("first.txt", new TextEncoder().encode("not a proof"), slow.promise));
    choose(proof, fakeFile("second.ots", pendingProof));
    choose(file, fakeFile("the-file.txt", content));
    await vi.waitFor(() => expect(text(el)).toContain("Not verified yet"));
    slow.resolve();
    await settle();
    expect(text(el)).toContain("second.ots");
    expect(text(el)).not.toContain("This is not a timestamp proof");
    expect(text(el)).not.toContain("first.txt");
  });

  it("drops a proof's read still under way when the proof is removed", async () => {
    const { el, proof } = open();
    choose(proof, fakeFile("first.ots", pendingProof));
    await vi.waitFor(() => expect(text(el)).toContain("first.ots"));
    const slow = deferred();
    choose(proof, fakeFile("second.ots", pendingProof, slow.promise));
    const remove = el.querySelector('button[aria-label="Remove the proof"]');
    if (!(remove instanceof HTMLButtonElement)) throw new TypeError("no remove button");
    remove.click();
    slow.resolve();
    await settle();
    expect(text(el)).not.toContain("second.ots");
    expect(text(el)).not.toContain("first.ots");
  });

  it("never says a replaced file's hashing stopped once its replacement is done", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("p.ots", pendingProof));
    const slow = deferred();
    choose(file, fakeFile("first.bin", new Uint8Array(1000), slow.promise));
    // The first job is under way before it is replaced.
    await vi.waitFor(() => expect(text(el)).toContain("Hashing, 0%"));
    choose(file, fakeFile("the-file.txt", content));
    await vi.waitFor(() => expect(text(el)).toContain("Not verified yet"));
    slow.resolve();
    await settle();
    expect(text(el)).not.toContain("Hashing stopped");
    expect(text(el)).toContain("Not verified yet");
  });
});
