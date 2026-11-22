// Copying text, on HTTPS and on plain HTTP alike. CopyButton and the public docs' script use it.

/**
 * Copies text with the synchronous copy command, from a hidden read-only textarea. Plain HTTP
 * leaves only this way, since the async clipboard exists only in a secure context. It counts as
 * the reader's gesture only inside the click's own task. Says whether the browser copied.
 */
export function copyByCommand(value: string): boolean {
  const focused = document.activeElement;
  const { scrollX, scrollY } = window;
  const area = document.createElement("textarea");
  area.className = "copy__scratch";
  // Read-only, so a phone shows no keyboard; the value goes in as text.
  area.readOnly = true;
  area.value = value;
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  document.body.append(area);
  area.select();
  // iOS Safari copies only a selection range set on the element itself.
  area.setSelectionRange(0, value.length);
  let copied = false;
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- the only way to copy outside a secure context
    copied = document.execCommand("copy");
  } catch {
    // Some browsers throw rather than answer false.
  }
  area.remove();
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  window.scrollTo(scrollX, scrollY);
  return copied;
}

/**
 * Copies text and says whether it landed: the async clipboard where the page has it, the copy
 * command where it has not (plain HTTP) or where it refused.
 */
export async function copyText(value: string): Promise<boolean> {
  // Undefined outside a secure context, whatever the types say.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  // Runs before the first await, so still inside the click's task.
  if (!clipboard) return copyByCommand(value);
  try {
    await clipboard.writeText(value);
    return true;
  } catch {
    return copyByCommand(value);
  }
}
