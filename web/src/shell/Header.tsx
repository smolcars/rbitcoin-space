import { useIsRouting, useLocation } from "@solidjs/router";
import { type Accessor, onSettled } from "solid-js";
import { Link } from "../components/Link";
import { SearchField } from "../components/SearchField";
import { type Network, networkFromPath, stripNetwork } from "../lib/network";
import { Logo } from "./Logo";
import { NetworkSwitch } from "./NetworkSwitch";
import { ThemeToggle } from "./ThemeToggle";
import "./Header.css";
import { dragScroll } from "../components/dragScroll";
import { PaletteKey } from "../palette/PaletteKey";
import { owned } from "../components/owned";

const NAV = [
  { href: "/blocks", label: "Blocks", match: (p: string) => /^\/blocks?(\/|$)/.test(p) },
  { href: "/mempool", label: "Mempool", match: (p: string) => /^\/(mempool|rbf)(\/|$)/.test(p) },
  { href: "/mining", label: "Mining", match: (p: string) => /^\/mining(\/|$)/.test(p) },
  { href: "/lightning", label: "Lightning", match: (p: string) => /^\/lightning(\/|$)/.test(p) },
  { href: "/ark", label: "Ark", match: (p: string) => /^\/ark(\/|$)/.test(p) },
];

/**
 * The tabs a network offers: Lightning only where its operator switched it on, Ark only where it
 * has an implementation. Both lists come from the server; while it has not answered, neither shows.
 */
export function tabs(
  network: Network,
  lightning: readonly Network[] | undefined,
  ark: Partial<Record<Network, string[]>> | undefined,
) {
  return NAV.filter(
    (item) =>
      (item.href !== "/lightning" || (lightning?.includes(network) ?? false)) &&
      (item.href !== "/ark" || (ark?.[network]?.length ?? 0) > 0),
  );
}

export function Header(props: {
  networks: Accessor<readonly Network[] | undefined>;
  /** The Ark implementations of each network, from the server; Ark shows only where there is one. */
  ark: Accessor<Partial<Record<Network, string[]>> | undefined>;
  /** The networks with Lightning switched on, from the server. */
  lightning: Accessor<readonly Network[] | undefined>;
}) {
  const location = useLocation();
  const isRouting = useIsRouting();
  const page = () => stripNetwork(location.pathname);
  const nav = () => tabs(networkFromPath(location.pathname), props.lightning(), props.ark());
  let search: HTMLInputElement | undefined;
  /** The search's text while it has focus: the palette opened from it starts there. */
  const typed = () =>
    search !== undefined && document.activeElement === search ? search.value : "";
  let header: HTMLElement | undefined;

  // The header is sticky and its height follows the width and the reader's text size: the page
  // keeps that much clear above whatever focus or a link scrolls to (global.css), so nothing the
  // keyboard reaches is hidden under it.
  onSettled(() => {
    const el = header;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const root = document.documentElement;
    let frame = 0;
    // Written in the next frame, not in the observer: WebKit reported a style change made there as
    // a resize loop.
    const seen = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        root.style.setProperty("--header-h", `${el.offsetHeight}px`),
      );
    });
    seen.observe(el);
    // Firefox leaves an element that focus reaches from below partly under the header, whatever
    // the scroll padding: it is brought clear of it.
    const clear = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || el.contains(t) || !t.matches(":focus-visible")) return;
      if (getComputedStyle(el).position !== "sticky") return;
      if (t.getBoundingClientRect().top < el.getBoundingClientRect().bottom) {
        t.scrollIntoView({ block: "nearest" });
      }
    };
    document.addEventListener("focusin", clear);
    return () => {
      seen.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", clear);
    };
  });

  // "/" jumps to search from anywhere but a text field.
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      e.preventDefault();
      search?.focus();
      search?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <header class="site-header" ref={header}>
      <div class="site-header__inner">
        <Link class="brand tap" href="/">
          <Logo />
          <span class="brand__word">rbitcoin.space</span>
        </Link>
        <NetworkSwitch networks={props.networks} />
        <div class="site-header__search">
          <SearchField ref={(el) => (search = el)} />
          <PaletteKey typed={typed} query={() => search?.value ?? ""} />
        </div>
        <nav class="nav" aria-label="Main" ref={owned((el) => dragScroll(el))}>
          {nav().map((item) => (
            // "true", the current section, not "page": the router marks and unmarks "page" on
            // links whose address is exactly the page's, and took the mark off when a query
            // or a child page differed. A value it did not write, it leaves alone.
            // oxlint-disable-next-line unicorn/prefer-regexp-test -- `match` is our own function, not String#match
            <Link href={item.href} aria-current={item.match(page()) ? "true" : "false"}>
              {item.label}
            </Link>
          ))}
        </nav>
        <ThemeToggle />
      </div>
      <div
        class={["route-progress", { "route-progress--on": isRouting() }]}

        aria-hidden="true"
      />
    </header>
  );
}
