// The page's choices against reads that finish out of order (review round 1, T4): every result
// belongs to the choice that started it, and a later choice or a removal makes earlier ones moot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "../../components/test-utils";
import { clearApiCache } from "../../lib/api";
import { CHUNK } from "./digest";
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

const text = (el: Element) => el.textContent ?? "";
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
  it("draws a filled slot as one row, names what Change changes, and clears a digest (council F-D1, N-D2)", async () => {
    const { el, proof } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    await vi.waitFor(() => expect(text(el)).toContain("a.ots"));
    const [proofSlot, fileSlot] = [...el.querySelectorAll(".ots-slot")];
    expect(proofSlot?.classList.contains("ots-slot--chosen")).toBe(true);
    expect(fileSlot?.classList.contains("ots-slot--chosen")).toBe(false);
    expect(text(proofSlot?.querySelector(".ots-slot__choose") ?? el)).toBe("Change the proof");
    // The digest field: what it takes, said, and a control that empties it.
    expect(text(el.querySelector("#ots-hex-hint") ?? el)).toBe("64 characters, 0 to 9 and a to f");
    const field = el.querySelector("textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new TypeError("no digest field");
    expect(el.querySelector('button[aria-label="Clear the digest"]')).toBeNull();
    field.value = "abc";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(el.querySelector('button[aria-label="Clear the digest"]')).not.toBeNull(),
    );
    el.querySelector<HTMLButtonElement>('button[aria-label="Clear the digest"]')?.click();
    await vi.waitFor(() => expect(field.value).toBe(""));
    expect(document.activeElement).toBe(field);
  });

  it("shows every value in the steps whole at a press, with no hover needed (council N-D3)", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    choose(file, fakeFile("the-file.txt", content));
    await vi.waitFor(() => expect(text(el)).toContain("This file existed before block 100"));
    const digest = toHex(hash("sha256", content));
    const first = () => text(el.querySelector(".ots-step__value") ?? el);
    expect(first()).not.toBe(digest);
    expect(text(el)).not.toContain("hover");
    const full = [...el.querySelectorAll("button")].find(
      (b) => text(b) === "Show the values in full",
    );
    full?.click();
    await vi.waitFor(() => expect(full?.getAttribute("aria-pressed")).toBe("true"));
    expect(first()).toBe(digest);
    full?.click();
    await vi.waitFor(() => expect(first()).not.toBe(digest));
  });

  it("puts the block's header time as the one figure under the headline (council F-D2, A-D1)", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    choose(file, fakeFile("the-file.txt", content));
    await vi.waitFor(() => expect(text(el)).toContain("This file existed before block 100"));
    const figures = [...el.querySelectorAll(".ots-figures dt")].map((dt) => text(dt));
    // The headline names the block, linked; the figure under it is its header time, and the
    // height is not said again (council A-D1).
    expect(figures).toStrictEqual(["Its header time"]);
    expect(el.querySelector(".ots-verdict__title a")?.getAttribute("href")).toMatch(/^\/block\//);
    expect(text(el.querySelector(".ots-verdict") ?? el).match(/\b100\b/g)).toHaveLength(1);
    expect(text(el.querySelector(".ots-figures__caveat") ?? el)).toMatch(
      /^The header time is the miner's claim/,
    );
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

describe("a file with no name (code review G-5)", () => {
  it("still shows its size beside its controls", async () => {
    const { el, file } = open();
    choose(file, fakeFile("", content));
    await vi.waitFor(() => expect(el.querySelectorAll(".ots-slot--chosen")).toHaveLength(1));
    const slot = el.querySelector(".ots-slot--chosen");
    expect(slot?.querySelector(".ots-slot__chosen")?.textContent).toContain("9 B");
  });
});

// When a verdict may move the reader's focus (docs/FRONTEND.md "Timestamp proofs", code review
// S-1, S-2, G-2, and round 2 S-7, S-8, G-6 to G-8): it takes focus where the reader's last action
// left it (what had focus when they acted, or nowhere); anywhere else it is announced and nothing
// moves. Every way an attempt ends forgets its action. The block's answer is held, so each
// verdict comes late.
describe("when a verdict takes the reader's focus", () => {
  let gate = deferred();
  let fail = false;
  beforeEach(() => {
    const block = madeBlock();
    gate = deferred();
    fail = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/block-height/100")) {
        await gate.promise;
        if (fail) return Response.json({ error: "broken" }, { status: 500 });
        return new Response(block.hash);
      }
      if (url.endsWith(`/api/block/${block.hash}/header`)) return new Response(block.header);
      return Response.json({ networks: ["mainnet"], version: "0" });
    });
  });
  const heading = (el: HTMLElement) => el.querySelector(".ots-verdict__title");
  const said = (el: HTMLElement) => el.querySelector("#ots-said")?.textContent ?? "";
  /** The proof chosen, and the digest field with the matching digest typed into it. */
  const typed = async (el: HTMLElement, proof: Element | undefined) => {
    choose(proof, fakeFile("a.ots", verifiedProof));
    await vi.waitFor(() => expect(el.querySelector("textarea")).not.toBeNull());
    const field = el.querySelector("textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new TypeError("no digest field");
    field.focus();
    field.value = toHex(hash("sha256", content));
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return field;
  };
  const enter = (field: HTMLElement) =>
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  it("takes focus when it stayed on the control that caused the verdict", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    if (file instanceof HTMLElement) file.focus();
    choose(file, fakeFile("the-file.txt", content));
    gate.resolve();
    await vi.waitFor(() => expect(document.activeElement).toBe(heading(el)));
  });

  it("takes focus when focus is on nothing in particular", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    choose(file, fakeFile("the-file.txt", content));
    expect(document.activeElement).toBe(document.body);
    gate.resolve();
    await vi.waitFor(() => expect(document.activeElement).toBe(heading(el)));
  });

  it("leaves focus on another control the reader moved to, and says the verdict instead", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    if (file instanceof HTMLElement) file.focus();
    choose(file, fakeFile("the-file.txt", content));
    // While the block is looked up, the reader moves to the proof's Change.
    if (proof instanceof HTMLElement) proof.focus();
    gate.resolve();
    await vi.waitFor(() => expect(said(el)).toContain("This file existed before block 100"));
    expect(document.activeElement).toBe(proof);
  });

  it("leaves focus in the digest field while it is typed in, and says the verdict", async () => {
    const { el, proof } = open();
    const field = await typed(el, proof);
    gate.resolve();
    await vi.waitFor(() => expect(said(el)).toContain("This digest is committed to by block 100"));
    expect(document.activeElement).toBe(field);
    // Enter now, with the verdict there: it is brought to the reader.
    enter(field);
    expect(document.activeElement).toBe(heading(el));
    expect(field.value).toHaveLength(64);
  });

  it("honours Enter pressed before the verdict came", async () => {
    const { el, proof } = open();
    const field = await typed(el, proof);
    enter(field);
    expect(el.querySelector(".ots-verdict")).toBeNull();
    gate.resolve();
    await vi.waitFor(() => expect(document.activeElement).toBe(heading(el)));
  });

  it("forgets that Enter once the reader types again", async () => {
    const { el, proof } = open();
    const field = await typed(el, proof);
    enter(field);
    field.value = `${field.value} `;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    gate.resolve();
    await vi.waitFor(() => expect(said(el)).toContain("This digest is committed to by block 100"));
    expect(document.activeElement).toBe(field);
  });

  const button = (el: HTMLElement, name: string) => {
    const b = [...el.querySelectorAll("button")].find(
      (x) => x.getAttribute("aria-label") === name || text(x) === name,
    );
    if (!(b instanceof HTMLButtonElement)) throw new TypeError(`no button ${name}`);
    return b;
  };
  /** The first lookup fails and its error shows; the next one is held until `gate` opens again. */
  const failOnce = async (el: HTMLElement) => {
    fail = true;
    gate.resolve();
    await vi.waitFor(() => expect(text(el)).toContain("Could not check the block"));
    fail = false;
    gate = deferred();
    button(el, "Try again").click();
  };

  it("forgets an Enter pressed before a check that failed (round 2 S-8, A1)", async () => {
    const { el, proof } = open();
    const field = await typed(el, proof);
    enter(field);
    await failOnce(el);
    field.focus();
    gate.resolve();
    await vi.waitFor(() => expect(said(el)).toContain("This digest is committed to by block 100"));
    expect(document.activeElement).toBe(field);
  });

  it("forgets the chooser of a check that failed (round 2 G-8, A2)", async () => {
    const { el, proof, file } = open();
    choose(proof, fakeFile("a.ots", verifiedProof));
    if (file instanceof HTMLElement) file.focus();
    choose(file, fakeFile("the-file.txt", content));
    await failOnce(el);
    // Back to the file's chooser while the retry is under way.
    if (file instanceof HTMLElement) file.focus();
    gate.resolve();
    await vi.waitFor(() => expect(said(el)).toContain("This file existed before block 100"));
    expect(document.activeElement).toBe(file);
  });

  it("forgets the chooser of a proof once it is removed (round 2 G-8, A3)", async () => {
    const { el, proof, file } = open();
    const lost = {
      name: "gone.txt",
      size: 10,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("NotReadableError")) }),
    };
    choose(file, lost as unknown as File);
    await vi.waitFor(() => expect(text(el)).toContain("Your file could not be read"));
    if (proof instanceof HTMLElement) proof.focus();
    choose(proof, fakeFile("bad.ots", new TextEncoder().encode("not a proof")));
    await vi.waitFor(() => expect(document.activeElement).toBe(heading(el)));
    button(el, "Remove the proof").click();
    await vi.waitFor(() => expect(said(el)).toBe("Your file could not be read"));
    expect(document.activeElement).toBe(proof);
  });

  it("forgets the chooser of a proof once hashing is stopped (round 3 S-11)", async () => {
    const { el, proof, file } = open();
    const bytes = deferred();
    choose(file, fakeFile("big.bin", new Uint8Array(CHUNK + 1), bytes.promise));
    await vi.waitFor(() => expect(text(el)).toContain("Hashing, 0%"));
    const slow = deferred();
    if (proof instanceof HTMLElement) proof.focus();
    choose(proof, fakeFile("bad.ots", new TextEncoder().encode("not a proof"), slow.promise));
    button(el, "Stop").click();
    // The hash sees the Stop once the read under way returns.
    bytes.resolve();
    await vi.waitFor(() => expect(text(el)).toContain("Hashing stopped"));
    // Back to the proof's chooser before its read finishes.
    if (proof instanceof HTMLElement) proof.focus();
    slow.resolve();
    await vi.waitFor(() => expect(said(el)).toBe("This is not a timestamp proof"));
    expect(document.activeElement).toBe(proof);
  });

  it("takes focus for a file dropped while another control has it (round 2 G-7, C)", async () => {
    const { el, proof } = open();
    if (proof instanceof HTMLElement) proof.focus();
    choose(proof, fakeFile("a.ots", verifiedProof));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [fakeFile("the-file.txt", content)] },
    });
    el.querySelectorAll(".ots-slot")[1]?.dispatchEvent(drop);
    gate.resolve();
    await vi.waitFor(() => expect(document.activeElement).toBe(heading(el)));
  });

  it("says each verdict, one with the same heading too, and nothing once it is gone (round 2 S-7, G-6)", async () => {
    const { el, proof } = open();
    gate.resolve();
    const region = el.querySelector("#ots-said");
    if (!(region instanceof HTMLElement)) throw new TypeError("no live region");
    const seen: string[] = [];
    new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const wrong = "The digest you gave is not the one this proof starts from";
    const field = await typed(el, proof);
    const type = (v: string) => {
      field.value = v;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    type("a".repeat(64));
    await vi.waitFor(() => expect(said(el)).toBe(wrong));
    type("b".repeat(64));
    await vi.waitFor(() => expect(seen.filter((t) => t === wrong)).toHaveLength(2));
    expect(seen.slice(seen.indexOf(wrong))).toContain("");
    type("");
    await vi.waitFor(() => expect(said(el)).toBe(""));
    expect(seen.join(" ")).not.toMatch(/aaaa|bbbb|a\.ots|the-file/);
  });
});
