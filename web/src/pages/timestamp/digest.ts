// The reader's file, hashed in the browser a chunk at a time: memory stays at one chunk whatever
// the file's size, each chunk's read lets the page draw, and an abort stops between chunks.
import { createHasher, DIGEST_LENGTH, fromHex, type HashName } from "./hashes";

/** 4 MiB: about 20 ms of SHA-256 each, so the page answers between chunks. */
export const CHUNK = 4 * 1024 * 1024;

/** The file's digest. `progress` gets the bytes hashed so far after each chunk. */
export async function hashFile(
  file: Blob,
  name: HashName,
  progress: (done: number) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const h = createHasher(name);
  for (let at = 0; at < file.size; at += CHUNK) {
    signal.throwIfAborted();
    // oxlint-disable-next-line no-await-in-loop -- one chunk in memory at a time is the point
    const chunk = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
    signal.throwIfAborted();
    h.update(chunk);
    progress(Math.min(at + CHUNK, file.size));
  }
  signal.throwIfAborted();
  return h.digest();
}

/** A digest typed or pasted as hex, for the hash `name`: spaces dropped, either case. */
export function readDigest(text: string, name: HashName): Uint8Array | null {
  const hex = text.replaceAll(/\s/g, "").toLowerCase();
  if (hex.length !== DIGEST_LENGTH[name] * 2) return null;
  return fromHex(hex);
}

/** The words for a hash in the page's copy. */
export const HASH_NAMES: Record<HashName, string> = {
  sha256: "SHA-256",
  sha1: "SHA-1",
  ripemd160: "RIPEMD-160",
  keccak256: "Keccak-256",
};
