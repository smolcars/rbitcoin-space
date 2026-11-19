// The same object for the same thing from one answer to the next.
//
// A list keeps a row's elements for as long as it is given the same object (`DataTable` keys a row
// by its object), and every answer is parsed into new objects. A page that hands the new ones on
// rebuilds every row each time it asks again: a reader loses the focus in a row, and a note they
// were sent to is replaced under them (docs/FRONTEND.md, "Following live data").

/**
 * Whether two values parsed from JSON are the same in every field, however deep. Exact, never a
 * digest: an answer that changed in one field is never taken for the one held.
 */
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameContent(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => Object.hasOwn(right, k) && sameContent(left[k], right[k]));
}

/**
 * Makes a function that maps each answer's items to the objects already held for them: an item is
 * the one held when it has the same `key` and the same content, every field of it, so nothing a
 * later answer changed is ever hidden behind an old object. An item that is the very object held
 * (a page loaded before and not asked again) is taken as it is, with nothing compared. It holds
 * only the last answer's items.
 */
export function steady<T>(key: (item: T) => string): (items: readonly T[]) => T[] {
  let held = new Map<string, T>();
  return (items) => {
    const next = new Map<string, T>();
    const out = items.map((item) => {
      const k = key(item);
      const old = held.get(k);
      const kept = old !== undefined && (old === item || sameContent(old, item)) ? old : item;
      next.set(k, kept);
      return kept;
    });
    held = next;
    return out;
  };
}
