// Reading a QR code from a camera frame or a picture, in the browser: nothing is sent anywhere.
// The browser's own BarcodeDetector where it reads QR codes (Chrome on Android and macOS);
// elsewhere jsQR, a chunk of its own fetched only when the scanner opens.

/** A camera frame (cut to what the preview shows) or a decoded picture, with its size in pixels. */
export type Source = HTMLCanvasElement | ImageBitmap;

/**
 * Reads the first QR code in a source: its text, or null when it holds none. `attempt` (from 0 to
 * the decoder's `attempts` less one) picks how it is read; each reads some codes the others miss.
 */
export type Detect = (
  source: Source,
  width: number,
  height: number,
  attempt: number,
) => Promise<string | null>;

export interface Decoder {
  /** Which reader this is: the browser's, or jsQR. */
  kind: "native" | "jsqr";
  /** How many different ways it can read a source. */
  attempts: number;
  detect: Detect;
}

// The Shape Detection API is not in TypeScript's DOM types; only what is used here.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect: (source: Source) => Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats: () => Promise<string[]>;
}

/** The browser's BarcodeDetector when it exists and reads QR codes; null otherwise. */
export async function nativeDecoder(scope: object = globalThis): Promise<Decoder | null> {
  const found: unknown = Reflect.get(scope, "BarcodeDetector");
  if (typeof found !== "function") return null;
  const Detector = found as BarcodeDetectorClass;
  try {
    // Chrome on Linux and Windows has the class but no formats.
    if (!(await Detector.getSupportedFormats()).includes("qr_code")) return null;
    const detector = new Detector({ formats: ["qr_code"] });
    return {
      kind: "native",
      attempts: 1,
      detect: async (source) =>
        (await detector.detect(source)).find((c) => c.rawValue.trim() !== "")?.rawValue ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The ways jsQR reads a source: its longer side scaled to `side` (never up), drawn `shift` pixels
 * in from the corner. jsQR takes text and edges near a code for finder patterns at some sizes and
 * not at others, and thresholds in blocks that fall differently with a shift. On 60 screenshots
 * of the site's own address codes (five types, 1x to 3x, light and dark pages, the pop-up alone
 * and the whole page), the first way read 33 and the five together all 60 (November 2026).
 */
export const WAYS: readonly { side: number; shift: number }[] = [
  { side: 1024, shift: 0 },
  { side: 768, shift: 3 },
  { side: 560, shift: 3 },
  { side: 400, shift: 0 },
  { side: 320, shift: 6 },
];

/**
 * The part of a camera frame the preview shows: its middle square, as the square well crops the
 * video to cover it. Only that is read, so the scanner never follows a code the reader cannot see.
 */
export function visibleSquare(
  width: number,
  height: number,
): { x: number; y: number; side: number } {
  const side = Math.max(1, Math.min(width, height));
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** The size a source is read at: its longer side scaled to `side`, never up, never to 0. */
export function fitted(
  width: number,
  height: number,
  side: number,
): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** jsQR, on a canvas of its own. Rejects when its chunk cannot be fetched. */
export async function jsqrDecoder(): Promise<Decoder> {
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("No 2D canvas to read the picture with");
  return {
    kind: "jsqr",
    attempts: WAYS.length,
    detect: (source, w, h, attempt) => {
      const way = WAYS[attempt % WAYS.length] ?? { side: 1024, shift: 0 };
      const { width, height } = fitted(w, h, way.side);
      canvas.width = width + way.shift;
      canvas.height = height + way.shift;
      // White under the shift, as the quiet zone round a code is.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = "high";
      context.drawImage(source, way.shift, way.shift, width, height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      // jsQR's default tries both ways: a code drawn light on dark reads only inverted.
      const text = jsQR(data, canvas.width, canvas.height)?.data;
      // A code of nothing but spaces leads nowhere: as good as no code.
      return Promise.resolve(text === undefined || text.trim() === "" ? null : text);
    },
  };
}

/** The browser's reader if it has one for QR codes, else jsQR. */
export async function createDecoder(): Promise<Decoder> {
  return (await nativeDecoder()) ?? jsqrDecoder();
}

/** Reads a picture every way the decoder has, in turn, until one finds a code. */
export async function readPicture(
  decoder: Decoder,
  source: Source,
  width: number,
  height: number,
): Promise<string | null> {
  for (let attempt = 0; attempt < decoder.attempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each way is tried only when the one before found nothing
    const text = await decoder.detect(source, width, height, attempt);
    if (text !== null) return text;
  }
  return null;
}
