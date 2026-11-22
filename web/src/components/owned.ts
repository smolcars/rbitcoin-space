import { createRoot, onCleanup } from "solid-js";

/**
 * A `ref` that runs `setup` on its element with an owner of its own, so the cleanups `setup`
 * registers (an observer's disconnect, a listener's removal) run when the component goes, or
 * when the ref is given another element. Solid runs a ref with no owner, where `onCleanup` does
 * nothing. Call it in the component's body, which has one.
 */
export function owned<E extends Element>(setup: (el: E) => void): (el: E) => void {
  let dispose: (() => void) | undefined;
  onCleanup(() => dispose?.());
  return (el) => {
    dispose?.();
    createRoot((d) => {
      dispose = d;
      setup(el);
    });
  };
}
