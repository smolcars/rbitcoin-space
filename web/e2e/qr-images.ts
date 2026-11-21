// QR codes as files for the scanner's browser tests: a PNG to choose as a picture, and a Y4M video
// for Chromium's fake camera (`--use-file-for-fake-video-capture`). Drawn from the site's own
// encoder (src/lib/qr.ts, checked against python-qrcode), plain: square modules, a quiet zone.
import { deflateSync } from "node:zlib";
import { encodeQr } from "../src/lib/qr";

/** The code for `text` as a grey image `width` × `height`, the code `side` pixels across in its middle. */
function draw(text: string, width: number, height: number, side: number): Uint8Array {
  const code = encodeQr(text, "M");
  if (!code) throw new Error(`no QR code holds ${text.length} characters`);
  const quiet = 4;
  const modules = code.size + 2 * quiet;
  const px = Math.floor(side / modules);
  const left = Math.floor((width - modules * px) / 2);
  const top = Math.floor((height - modules * px) / 2);
  const grey = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (code.dark[y * code.size + x] !== 1) continue;
      for (let dy = 0; dy < px; dy += 1) {
        const row = (top + (y + quiet) * px + dy) * width;
        grey.fill(0, row + left + (x + quiet) * px, row + left + (x + quiet + 1) * px);
      }
    }
  }
  return grey;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A greyscale PNG of `grey`, `size` pixels square. */
function png(grey: Uint8Array, size: number): Buffer {
  // Each row starts with its filter byte, 0 (none).
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw.set(grey.subarray(y * size, (y + 1) * size), y * (size + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** A PNG of the code for `text`, as a screenshot of it would hold it. */
export function qrPng(text: string, size = 480): Buffer {
  return png(draw(text, size, size, size), size);
}

/** A white PNG: a picture with no code in it. */
export function blankPng(size = 64): Buffer {
  return png(new Uint8Array(size * size).fill(255), size);
}

/** One frame of Y4M video, 640 × 480, showing the code for `text`; Chromium plays it in a loop. */
export function qrY4m(text: string): Buffer {
  const width = 640;
  const height = 480;
  const luma = draw(text, width, height, 360);
  // 4:2:0 colour planes at a quarter size each, neutral: a grey picture.
  const chroma = Buffer.alloc((width / 2) * (height / 2) * 2, 128);
  return Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\nFRAME\n`, "ascii"),
    luma,
    chroma,
  ]);
}
