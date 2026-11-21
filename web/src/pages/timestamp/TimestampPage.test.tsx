// The page's choices against reads that finish out of order (review round 1, T4): every result
// belongs to the choice that started it, and a later choice or a removal makes earlier ones moot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import { hash, toHex } from "./hashes";
import { headerHash } from "./verify";
import TimestampPage from "./TimestampPage";
import { ATT, chain, OP, writeProof } from "./testdata";

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

/** A made-up block 100 whose root is reached from `content`'s digest by one append and SHA-256. */
function madeBlock(): { hash: string; header: string } {
  const root = hash("sha256", new Uint8Array([...hash("sha256", content), 1, 2, 3, 4]));
  const header = new Uint8Array(80);
  header.set(root, 36);
  return { hash: headerHash(header), header: toHex(header) };
}
const verifiedProof = writeProof(
  hash("sha256", content),
  chain([OP.append([1, 2, 3, 4]), OP.sha256], ATT.bitcoin(100)),
);

describe("a replacement chosen while a verdict shows (review round 2, T12)", () => {
  let heights = 0;
  beforeEach(() => {
    const block = madeBlock();
    heights = 0;
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/api/block-height/")) heights++;
      if (url.endsWith("/api/block-height/100")) return Promise.resolve(new Response(block.hash));
      if (url.endsWith(`/api/block/${block.hash}/header`))
        return Promise.resolve(new Response(block.header));
      return Promise.resolve(Response.json({ networks: ["mainnet"], version: "0" }));
    });
  });

  it("takes the old verdict down at once when another proof is chosen, and says it is reading", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    choose(file, fakeFile("the-file.txt", content));
    await vi.waitFor(() => expect(text(el)).toContain("This file existed before block 100"));
    const slow = deferred();
    choose(proof, fakeFile("b.ots", verifiedProof, slow.promise));
    await settle();
    expect(text(el)).not.toContain("This file existed before block 100");
    expect(text(el)).not.toContain("a.ots");
    expect(text(el)).toContain("Reading the proof");
    slow.resolve();
    await vi.waitFor(() => expect(text(el)).toContain("This file existed before block 100"));
  });

  it("takes the old verdict down at once when another file is chosen", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    choose(file, fakeFile("the-file.txt", content));
    await vi.waitFor(() => expect(text(el)).toContain("This file existed before block 100"));
    const asked = heights;
    const slow = deferred();
    choose(file, fakeFile("other.bin", new Uint8Array(1000), slow.promise));
    await settle();
    // Nothing is asked for a file not yet hashed: the last file's digest is not this one's.
    expect(heights).toBe(asked);
    expect(text(el)).not.toContain("This file existed before block 100");
    expect(text(el)).toContain("Hashing, 0%");
    slow.resolve();
    await vi.waitFor(() => expect(text(el)).toContain("This proof is not for this file"));
  });
});

describe("review round 3", () => {
  it("says a proof or a file that cannot be read could not be read, not that it breaks the format (T17)", async () => {
    const { el, proof, file } = open();
    const broken = {
      name: "gone.ots",
      size: 10,
      arrayBuffer: () => Promise.reject(new Error("NotReadableError")),
    };
    choose(proof, broken as unknown as File);
    await vi.waitFor(() => expect(text(el)).toContain("The proof file could not be read"));
    expect(text(el)).not.toContain("breaks the format");
    choose(proof, fakeFile("p.ots", pendingProof));
    const lost = {
      name: "gone.txt",
      size: 10,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("NotReadableError")) }),
    };
    choose(file, lost as unknown as File);
    await vi.waitFor(() => expect(text(el)).toContain("Your file could not be read"));
  });

  it("hashes a file once when the proof is replaced by one wanting the same hash (T19)", async () => {
    const { el, proof, file } = open();
    let starts = 0;
    const counted = fakeFile("the-file.txt", content);
    const slice = counted.slice.bind(counted);
    Object.assign(counted, {
      slice: (a?: number, b?: number) => {
        if (a === 0) starts++;
        return slice(a, b);
      },
    });
    choose(proof, fakeFile("a.ots", pendingProof));
    await vi.waitFor(() => expect(text(el)).toContain("a.ots"));
    choose(file, counted);
    await vi.waitFor(() => expect(text(el)).toContain("Not verified yet"));
    expect(starts).toBe(1);
    const slow = deferred();
    choose(proof, fakeFile("b.ots", pendingProof, slow.promise));
    await settle();
    slow.resolve();
    await vi.waitFor(() => expect(text(el)).toContain("Not verified yet"));
    expect(starts).toBe(1);
  });
});
