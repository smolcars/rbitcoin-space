// A page editor's save refused: what the page shows for the thing changed since the editor opened
// (docs/FRONTEND.md "Your labels"). Its own file: one class a file.
import type { Opened } from "../labels";
import { LabelStoreError } from "./store";

/**
 * A page editor's save refused because what the page shows for the thing is no longer the record
 * the editor opened on: `now` is what it shows instead, for the editor to say and open on.
 */
export class ChangedElsewhereError extends LabelStoreError {
  readonly now: { label: string | undefined; opened: Opened | null };
  constructor(now: { label: string | undefined; opened: Opened | null }) {
    super("changed");
    this.now = now;
    this.name = "ChangedElsewhereError";
  }
}
