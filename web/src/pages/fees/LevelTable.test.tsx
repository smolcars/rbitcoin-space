// LevelTable watches its table's fit with a ResizeObserver, which jsdom lacks: a stand-in counts
// what is observed and disconnected, so an unmounted table is shown to leave nothing running.
import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LevelTable } from "./LevelTable";

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

afterEach(() => {
  vi.unstubAllGlobals();
  live.length = 0;
  document.body.replaceChildren();
});

describe("LevelTable", () => {
  it("stops watching its table when it goes (code review G-1)", async () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const el = document.createElement("div");
    document.body.append(el);
    const dispose = render(
      () => (
        <LevelTable
          caption="Levels"
          columns={[
            { header: "Level", cell: (r: string) => r },
            { header: "Figure", cell: () => "1" },
          ]}
          rows={["Low", "High"]}
          name={(r) => r}
        />
      ),
      el,
    );
    // Its own observer, the one watching the table's box (DataTable's are tested with it).
    const own = () =>
      live.filter((o) => o.watched.some((w) => w.classList.contains("level-table")));
    await vi.waitFor(() => expect(own()).toHaveLength(1));
    expect(own()[0]?.disconnected).toBe(false);
    dispose();
    expect(own()[0]?.disconnected).toBe(true);
  });
});
