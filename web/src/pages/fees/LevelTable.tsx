// A table of the four levels that becomes one labelled group per level where it does not fit its
// panel (a phone at large text), so no figure is ever scrolled away from its level's name. Whether
// it fits is measured, not guessed from the width: the table stays laid out, out of sight and out
// of the accessibility tree, and is shown again as soon as it fits.
import { createSignal, For, onSettled, Show } from "solid-js";
import { type Column, DataTable } from "../../components/DataTable";

export function LevelTable<T>(props: {
  caption: string;
  columns: Column<T>[];
  rows: readonly T[];
  /** The row's name, the group's heading. */
  name: (row: T) => string;
}) {
  const [grouped, setGrouped] = createSignal(false);
  let box: HTMLDivElement | undefined;
  // Set up once mounted, with an owner, so the observer and any queued frame go with the table.
  onSettled(() => {
    // Absent where there is no layout (tests): the table alone.
    if (!box || typeof ResizeObserver === "undefined") return undefined;
    const root = box;
    let frame = 0;
    let table: Element | null = null;
    const check = () => {
      frame = 0;
      const scroller = root.querySelector<HTMLElement>(".table-scroll");
      if (!scroller) return;
      // The table too, once it is there: a larger text widens it while the panel stays as it was.
      if (!table && scroller.firstElementChild) {
        table = scroller.firstElementChild;
        observer.observe(table);
      }
      setGrouped(scroller.scrollWidth > scroller.clientWidth + 1);
    };
    // The measured table keeps the panel's width whether shown or not, so a change here never
    // changes what is measured: no loop. One check a frame however many notices.
    const observer = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(check);
    });
    observer.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });
  const figures = () => props.columns.slice(1);
  return (
    <div class={["level-table", { "level-table--grouped": grouped() }]} ref={box}>
      <div class="level-table__table" aria-hidden={grouped() ? "true" : undefined}>
        <DataTable caption={props.caption} columns={props.columns} rows={props.rows} />
      </div>
      <Show when={grouped()}>
        <ul class="level-groups" aria-label={props.caption}>
          <For each={props.rows}>
            {(row, r) => (
              <li class="level-group">
                <h3 class="level-group__name">{props.name(row)}</h3>
                <dl class="level-group__figures">
                  <For each={figures()}>
                    {(c) => (
                      <div class="level-group__figure">
                        <dt>
                          {c.header}
                          <Show when={c.sub}>{(sub) => <span class="muted">, {sub()}</span>}</Show>
                        </dt>
                        <dd>{c.cell(row, r())}</dd>
                      </div>
                    )}
                  </For>
                </dl>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
