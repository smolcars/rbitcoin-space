// The same object for the same thing from one answer to the next.
//
// A list keeps a row's elements for as long as it is given the same object (`DataTable` keys a row
// by its object), and every answer is parsed into new objects. A page that hands the new ones on
// rebuilds every row each time it asks again: a reader loses the focus in a row, and a note they
// were sent to is replaced under them (docs/FRONTEND.md, "Following live data").

/** A fingerprint of a value's whole content: its JSON's length and a 32-bit FNV-1a hash of it. */
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    // Each UTF-16 unit, not each character: every unit counts, and none is skipped.
    // oxlint-disable-next-line unicorn/prefer-code-point -- a hash over code units, by index
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${json.length}:${hash >>> 0}`;
}

/**
 * Makes a function that maps each answer's items to the objects already held for them: an item is
 * the one held when it has the same `key` and the same content, every field of it, so nothing a
 * later answer changed is ever hidden behind an old object. It holds only the last answer's
 * items.
 */
export function steady<T>(key: (item: T) => string): (items: readonly T[]) => T[] {
  let held = new Map<string, { item: T; print: string }>();
  return (items) => {
    const next = new Map<string, { item: T; print: string }>();
    const out = items.map((item) => {
      const k = key(item);
      const print = fingerprint(item);
      const old = held.get(k);
      const kept = old !== undefined && old.print === print ? old : { item, print };
      next.set(k, kept);
      return kept.item;
    });
    held = next;
    return out;
  };
}
