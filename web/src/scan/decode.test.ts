import { describe, expect, it } from "vitest";
import { type Decoder, fitted, nativeDecoder, readPicture, visibleSquare } from "./decode";

/** A stand-in for the browser's BarcodeDetector: these formats, and these codes in every frame. */
function detector(formats: string[] | Error, codes: string[] = [], seen: string[][] = []) {
  // A function, as the decoder calls it with `new`; it answers its own object.
  function Detector(options: { formats: string[] }) {
    seen.push(options.formats);
    return { detect: () => Promise.resolve(codes.map((rawValue) => ({ rawValue }))) };
  }
  return Object.assign(Detector, {
    getSupportedFormats: () =>
      formats instanceof Error ? Promise.reject(formats) : Promise.resolve(formats),
  });
}

const frame = {} as ImageBitmap;

describe("nativeDecoder", () => {
  it("uses the browser's reader when it reads QR codes, asking it for QR codes only", async () => {
    const seen: string[][] = [];
    const reader = await nativeDecoder({
      BarcodeDetector: detector(["ean_13", "qr_code"], ["", "bitcoin:bc1q"], seen),
    });
    expect(reader?.kind).toBe("native");
    expect(seen).toStrictEqual([["qr_code"]]);
    // The first code with text in it.
    await expect(reader?.detect(frame, 1, 1, 0)).resolves.toBe("bitcoin:bc1q");
  });

  it("answers null for a frame with no code, or a code of nothing but spaces", async () => {
    const reader = await nativeDecoder({ BarcodeDetector: detector(["qr_code"]) });
    await expect(reader?.detect(frame, 1, 1, 0)).resolves.toBeNull();
    const blank = await nativeDecoder({ BarcodeDetector: detector(["qr_code"], ["   "]) });
    await expect(blank?.detect(frame, 1, 1, 0)).resolves.toBeNull();
  });

  it("is null without the class, without QR codes, or when asking for formats fails", async () => {
    await expect(nativeDecoder({})).resolves.toBeNull();
    // Chrome on Linux and Windows: the class, and no formats.
    await expect(nativeDecoder({ BarcodeDetector: detector([]) })).resolves.toBeNull();
    await expect(
      nativeDecoder({ BarcodeDetector: detector(new Error("no formats")) }),
    ).resolves.toBeNull();
  });
});

describe("fitted", () => {
  it("scales a large source down to the side asked for, keeping its shape", () => {
    expect(fitted(4032, 3024, 1024)).toStrictEqual({ width: 1024, height: 768 });
    expect(fitted(1170, 2532, 1024)).toStrictEqual({ width: 473, height: 1024 });
  });

  it("never scales up, and never answers a side of 0", () => {
    expect(fitted(640, 480, 1024)).toStrictEqual({ width: 640, height: 480 });
    expect(fitted(0, 0, 1024)).toStrictEqual({ width: 1, height: 1 });
  });
});

describe("readPicture", () => {
  it("tries each way in turn and stops at the first that reads", async () => {
    const tried: number[] = [];
    const decoder: Decoder = {
      kind: "jsqr",
      attempts: 5,
      detect: (_s, _w, _h, attempt) => {
        tried.push(attempt);
        return Promise.resolve(attempt === 2 ? "found" : null);
      },
    };
    await expect(readPicture(decoder, frame, 10, 10)).resolves.toBe("found");
    expect(tried).toStrictEqual([0, 1, 2]);
  });

  it("answers null when no way reads", async () => {
    const decoder: Decoder = { kind: "native", attempts: 1, detect: () => Promise.resolve(null) };
    await expect(readPicture(decoder, frame, 10, 10)).resolves.toBeNull();
  });
});

describe("visibleSquare", () => {
  it("is the middle square the preview shows of a wide or tall frame", () => {
    expect(visibleSquare(1280, 720)).toStrictEqual({ x: 280, y: 0, side: 720 });
    expect(visibleSquare(720, 1280)).toStrictEqual({ x: 0, y: 280, side: 720 });
    expect(visibleSquare(640, 640)).toStrictEqual({ x: 0, y: 0, side: 640 });
  });
});
