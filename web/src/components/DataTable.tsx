import { createSignal, flush, For, onCleanup, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Link } from "./Link";
import { scrollCue } from "./scrollCue";
import "./DataTable.css";
import { owned } from "./owned";

export interface Column<T> {
  /** Header text. Units go here ("Value, BTC"), so cells hold bare numbers. */
  header: string;
  cell: (row: T, index: number) => JSX.Element;
  /** Right-aligned numeric column. */
  numeric?: boolean;
  /** Dropped on phones, and at step 1 wherever the table does not fit. The least important. */
  optional?: boolean;
  /**
   * The step, 1 first, at which the column is dropped while the table is wider than its panel.
   * Never on the column that names a row or the one the list is sorted by.
   */
  drop?: number | undefined;
  /** A shorter header shown on phones ("Txs"); screen readers keep the full one. */
  short?: string;
  /** The header for screen readers only, where the rows name themselves in sight. */
  hidden?: boolean;
  /** A quieter second line under the header: whose figure it is, its unit. */
  sub?: string;
  /** The key the list sorts by when this header is pressed (`DataTableProps.sort`). */
  sort?: string;
}

/** A list the reader sorts by pressing a header: its key and direction, and what a press does. */
export interface TableSort {
  by: string;
  dir: "asc" | "desc";
  onSort: (by: string) => void;
}

export interface DataTableProps<T> {
  /** Says what the table lists; read by screen readers, hidden unless `showCaption`. */
  caption: string;
  showCaption?: boolean;
  columns: Column<T>[];
  rows: readonly T[];
  /** Shown instead of the table when there are no rows. */
  empty?: JSX.Element;
  /** A class for one row, such as a highlight for a row that just arrived. */
  rowClass?: (row: T) => string | undefined;
  /**
   * Where the whole row leads: a `paths` result. The row becomes one target a thumb can hit; its
   * own link in the cells stays the one keyboard stop, as the row link is hidden from both.
   */
  rowHref?: (row: T) => string | undefined;
  /** History state for the row's link, as JSON (the router's `state`); never the URL. */
  rowState?: (row: T) => string | undefined;
  /** Makes the headers of columns with a `sort` key buttons that sort the list. */
  sort?: TableSort;
  /**
   * A note under a row, across every column, such as a warning about it: drawn where `when` holds.
   * It is not part of the row's link.
   */
  rowNote?: { when: (row: T) => boolean; render: (row: T) => JSX.Element };
  /**
   * Told the step the table dropped its columns to after each fit (0: none dropped), so a page can
   * say what is left out. A phone's CSS hiding of `optional` columns is the page's own breakpoint.
   */
  onDropped?: (step: number) => void;
}

/** A table with units in headers, right-aligned numbers and row rules. */
export function DataTable<T>(props: DataTableProps<T>) {
  const cellClass = (c: Column<T>) =>
    [c.numeric && "table__num", c.optional && "table__optional", gone(c) && "table__gone"]
      .filter(Boolean)
      .join(" ") || undefined;
  const linkColumn = () =>
    Math.max(
      0,
      props.columns.findIndex((c) => c.optional !== true && c.drop === undefined),
    );
  // The step at which a column is dropped to fit: its `drop`, or 1 for an optional one; 0 never.
  const step = (c: Column<T>) => c.drop ?? (c.optional === true ? 1 : 0);
  const [dropped, setDropped] = createSignal(0);
  const gone = (c: Column<T>) => step(c) > 0 && step(c) <= dropped();
  /** Drops columns, least important first, until the table fits its panel or none are left. */
  const fit = (scroller: HTMLElement) => {
    const last = Math.max(0, ...props.columns.map(step));
    let width = -1;
    const over = () => scroller.scrollWidth > scroller.clientWidth + 1;
    const refit = () => {
      // A new width starts over, so columns come back where there is room again; content that
      // arrived and widened the table (a miner's name, a fee) drops more from where it is.
      const same = scroller.clientWidth === width;
      if (same && !over()) return;
      width = scroller.clientWidth;
      for (let d = same ? dropped() : 0; d <= last; d++) {
        setDropped(d);
        flush();
        if (!over()) break;
      }
      props.onDropped?.(dropped());
    };
    // Absent where there is no layout (tests): the phone's CSS still drops the optional columns.
    if (typeof ResizeObserver === "undefined") return;
    // Next frame, not inside the observer: resizing what it watches from its own callback is a
    // loop the browser reports (WebKit as an uncaught error). One refit however many notices.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refit();
      });
    });
    onCleanup(() => cancelAnimationFrame(frame));
    observer.observe(scroller);
    // The table too: its content can widen it while the panel stays as it was.
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    onCleanup(() => observer.disconnect());
  };
  const heading = (c: Column<T>) => (
    <>
      <Show
        when={c.short}
        fallback={c.hidden ? <span class="visually-hidden">{c.header}</span> : c.header}
      >
        {(short) => (
          <>
            <span class="table__long">{c.header}</span>
            <span class="table__short" aria-hidden="true">
              {short()}
            </span>
          </>
        )}
      </Show>
    </>
  );
  const sub = (c: Column<T>) => (
    <Show when={c.sub}>{(text) => <span class="table__sub">{text()}</span>}</Show>
  );
  return (
    <Show when={props.rows.length > 0 || props.empty === undefined} fallback={props.empty}>
      <div
        class="table-scroll"
        ref={owned((el) => {
          fit(el);
          scrollCue(el);
        })}
      >
        <table class={["table", { "table--rows": props.rowHref !== undefined }]}>
          <caption class={{ "visually-hidden": !props.showCaption, table__caption: true }}>
            {props.caption}
          </caption>
          <thead>
            <tr>
              <For each={props.columns}>
                {(c) => (
                  <th
                    scope="col"
                    class={cellClass(c)}
                    aria-sort={
                      c.sort !== undefined && c.sort === props.sort?.by
                        ? props.sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <Show
                      when={c.sort !== undefined && props.sort}
                      fallback={
                        <>
                          {heading(c)}
                          {sub(c)}
                        </>
                      }
                    >
                      {(s) => (
                        <button
                          class="table__sort"
                          type="button"
                          onClick={() => s().onSort(c.sort ?? "")}
                        >
                          {heading(c)}
                          <span class="table__arrow" aria-hidden="true">
                            {c.sort === s().by ? (s().dir === "asc" ? "↑" : "↓") : "↕"}
                          </span>
                        </button>
                      )}
                    </Show>
                    <Show when={c.sort !== undefined && props.sort}>{sub(c)}</Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(row, i) => (
                <>
                  <tr class={props.rowClass?.(row)}>
                    <For each={props.columns}>
                      {(c, k) => (
                        <td
                          class={cellClass(c)}
                          data-label={c.hidden === true ? undefined : c.header}
                        >
                          {c.cell(row, i())}
                          {/* In a column that is never dropped: a dropped one's link takes no room. */}
                          <Show when={k() === linkColumn() && props.rowHref?.(row)}>
                            {(href) => (
                              <Link
                                class="table__rowlink"
                                href={href()}
                                state={props.rowState?.(row)}
                                tabindex="-1"
                                aria-hidden="true"
                              />
                            )}
                          </Show>
                        </td>
                      )}
                    </For>
                  </tr>
                  <Show when={props.rowNote?.when(row) === true && props.rowNote}>
                    {(note) => (
                      <tr class="table__note">
                        <td colspan={props.columns.length}>{note().render(row)}</td>
                      </tr>
                    )}
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
