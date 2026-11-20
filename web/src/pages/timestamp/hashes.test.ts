import { describe, expect, it } from "vitest";
import { createHasher, fromHex, hash, type HashName, reversed, toHex } from "./hashes";

const text = (s: string) => new TextEncoder().encode(s);
const MILLION_A = text("a".repeat(1_000_000));
const TWO_BLOCKS = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";

// Each from the hash's own specification or its authors' published values.
const VECTORS: Record<HashName, [Uint8Array, string][]> = {
  // FIPS 180-2, Appendix B (and the empty string's, from NIST's examples).
  sha256: [
    [text(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    [text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [text(TWO_BLOCKS), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    [MILLION_A, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ],
  // FIPS 180-2, Appendix A.
  sha1: [
    [text("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d"],
    [text(TWO_BLOCKS), "84983e441c3bd26ebaae4aa1f95129e5e54670f1"],
    [MILLION_A, "34aa973cd4c4daa4f61eeb2bdbad27316534016f"],
  ],
  // "RIPEMD-160: A strengthened version of RIPEMD", Dobbertin, Bosselaers and Preneel, Appendix B.
  ripemd160: [
    [text(""), "9c1185a5c5e9fc54612808977ee8f548b2258d31"],
    [text("a"), "0bdc9d2d256b3ee9daae347be6f4dc835a467ffe"],
    [text("abc"), "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"],
    [text("message digest"), "5d0689ef49d2fae572b881b123a85ffa21595f36"],
    [text("abcdefghijklmnopqrstuvwxyz"), "f71c27109c692c1b56bbdceb5b9d2865b3708dbc"],
    [text(TWO_BLOCKS), "12a053384a9c0c88e405a06c27dcf49ada62eb2b"],
    [
      text("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
      "b0e20b6e3116640286ed3a87a5713079b21f5189",
    ],
    [text("1234567890".repeat(8)), "9b752e45573d4b39f4dbd3323cab82bf63326bfb"],
    [MILLION_A, "52783243c1697bdbe16d37f97f68f08325dc1528"],
  ],
  // The Keccak team's known answers for Keccak-256 (ShortMsgKAT_256: lengths 0, 8 and 16 bits),
  // and "abc", as Ethereum's keccak256 gives it.
  keccak256: [
    [text(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    [new Uint8Array([0xcc]), "eead6dbfc7340a56caedc044696a168870549a6a7f6f56961e84a54bd9970b8a"],
    [
      new Uint8Array([0x41, 0xfb]),
      "a8eaceda4d47b3281a795ad9e1ea2122b407baf9aabcb9e18b5717b7873537d2",
    ],
    [text("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  ],
};

const NAMES = Object.keys(VECTORS) as HashName[];

describe.each(NAMES)("%s", (name) => {
  const vectors = VECTORS[name];
  it("gives its published digests", () => {
    for (const [input, want] of vectors)
      expect({ length: input.length, got: toHex(hash(name, input)) }).toStrictEqual({
        length: input.length,
        got: want,
      });
  });

  it("gives the same digest however the input is cut", () => {
    // Every block edge is crossed: pieces of 1 to 200 bytes over 1,000.
    const input = new Uint8Array(1000).map((_, i) => (i * 31 + 7) & 0xff);
    const whole = toHex(hash(name, input));
    for (const piece of [1, 7, 55, 56, 63, 64, 65, 135, 136, 137, 200]) {
      const h = createHasher(name);
      for (let at = 0; at < input.length; at += piece) h.update(input.subarray(at, at + piece));
      expect({ piece, got: toHex(h.digest()) }).toStrictEqual({ piece, got: whole });
    }
  });
});

describe("hex", () => {
  it("reads and writes hex, and reverses bytes", () => {
    expect(fromHex("00ff10")).toStrictEqual(new Uint8Array([0, 255, 16]));
    expect(fromHex("0")).toBeNull();
    expect(fromHex("zz")).toBeNull();
    expect(toHex(reversed(new Uint8Array([1, 2, 3])))).toBe("030201");
  });
});
