// The reader's latest choice of where to go, for moves that wait on an answer before they
// navigate: the header search, the palette's lookups, an address's date. Each takes a turn when
// the reader makes the choice and asks, before it moves, whether a later choice was made since.
// A plain navigation (a link, Back) needs none: it moves at once, and those that wait drop
// themselves when a navigation starts (`useBeforeLeave`). docs/FRONTEND.md "An address as of a
// block".

let latest = 0;

/** A new choice: every older one still waiting is stale. Returns whether this one is the latest. */
export function intend(): () => boolean {
  latest += 1;
  const mine = latest;
  return () => mine === latest;
}
