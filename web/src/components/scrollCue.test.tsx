// scrollCue and DataTable watch a scroller with a ResizeObserver, which jsdom lacks: a stand-in
// records what is observed and disconnected, so an unmounted one is shown to leave nothing running.
// Set up from a ref, which Solid runs with no owner, they need `owned` for their cleanups to run.
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";
import { dragScroll } from "./dragScroll";
import { owned } from "./owned";
import { scrollCue } from "./scrollCue";

const live: { disconnected: boolean; watched: Element[] }[] = [];
class FakeObserver {
  disconnected = false;
  watched: Element[] = [];
  constructor() {
    live.push(this);
  }
  observe(el: Element) {
    this.watched.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
}

const mount = (view: () => unknown) => {
  const el = document.createElement("div");
  document.body.append(el);
  return render(view as () => never, el);
};

afterEach(() => {
  vi.unstubAllGlobals();
  live.length = 0;
  document.body.replaceChildren();
});

describe("observers set up for a scroller", () => {
  it("scrollCue's goes with the element it marks", async () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const dispose = mount(() => <div ref={owned(scrollCue)} />);
    await vi.waitFor(() => expect(live).toHaveLength(1));
    expect(live[0]?.disconnected).toBe(false);
    dispose();
    expect(live[0]?.disconnected).toBe(true);
  });

  it("a table's, its fit and its scroll cue, go with the table", async () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const dispose = mount(() => (
      <DataTable
        caption="Rows"
        columns={[{ header: "Name", cell: (r: string) => r }]}
        rows={["a", "b"]}
      />
    ));
    await vi.waitFor(() => expect(live).toHaveLength(2));
    expect(live.map((o) => o.disconnected)).toStrictEqual([false, false]);
    dispose();
    expect(live.map((o) => o.disconnected)).toStrictEqual([true, true]);
  });

  it("dragScroll's listeners go with the element they are on", async () => {
    let box: HTMLElement | undefined;
    const removed: string[] = [];
    const dispose = mount(() => (
      <div
        ref={owned((el) => {
          box = el;
          const remove = el.removeEventListener.bind(el);
          el.removeEventListener = (type: string, ...rest: [EventListener, boolean?]) => {
            removed.push(type);
            remove(type, ...rest);
          };
          dragScroll(el);
        })}
      />
    ));
    await vi.waitFor(() => expect(box).toBeDefined());
    expect(removed).toStrictEqual([]);
    dispose();
    expect(removed).toContain("pointerdown");
  });
});
