// The docs pages' one script (web/docs.html). The pages read whole without it; it adds the theme
// switch, copy buttons and the page menu, and shows the MCP actions where the server runs MCP.
import { copyByCommand, copyText } from "../lib/copy";
import { SITE } from "./pages";

const root = document.documentElement;
const main = document.querySelector<HTMLElement>(".docs-main");
const status = document.querySelector<HTMLElement>(".copied");
const mdPath = main?.dataset["md"] ?? "/docs.md";
const mcpUrl = `${location.origin}/mcp`;

let toastTimer = 0;
function say(text: string): void {
  if (!status) return;
  status.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (status.textContent = ""), 2000);
}

const FAILED = "Could not copy. Your browser blocked it";

async function copy(text: string, done = "Copied"): Promise<void> {
  say((await copyText(text)) ? done : FAILED);
}

function pageMarkdown(): Promise<string> {
  return fetch(mdPath).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  });
}

/**
 * Whether the page can hand the clipboard text still on its way. Undefined parts outside a secure
 * context, and in some browsers on HTTPS too, whatever the types say.
 */
const asyncWrite =
  typeof ClipboardItem !== "undefined" &&
  typeof (navigator.clipboard as Clipboard | undefined)?.write === "function";

/**
 * The page's Markdown, fetched at load where the clipboard cannot take a promise: the copy command
 * works only inside the click's own task, with the text already at hand.
 */
let prefetched: string | undefined;
let prefetching = false;
function prefetch(): void {
  if (prefetching || prefetched !== undefined) return;
  prefetching = true;
  pageMarkdown().then(
    (text) => {
      prefetched = text;
      prefetching = false;
    },
    () => (prefetching = false),
  );
}
if (!asyncWrite) prefetch();

/** Copies the page as Markdown. The text is still on its way: Safari keeps the click's permission
 * for a clipboard item given a promise. */
async function copyPage(done: string): Promise<void> {
  if (!asyncWrite) {
    if (prefetched === undefined) {
      // Still on its way, or it failed: ask again, and the next click copies.
      prefetch();
      say("Fetching the page. Try again in a moment");
    } else say(copyByCommand(prefetched) ? done : FAILED);
    return;
  }
  try {
    const blob = pageMarkdown().then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    say(done);
  } catch {
    say(FAILED);
  }
}

// Theme: the same choice the explorer keeps (src/lib/theme.ts), without its reactive parts.
function themeToggle(): void {
  const button = document.querySelector<HTMLButtonElement>(".theme-toggle");
  if (!button) return;
  const os = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const shown = () => {
    const t = root.dataset["theme"];
    return t === "light" || t === "dark" ? t : os();
  };
  const label = () => {
    const text = shown() === "dark" ? "Switch to light theme" : "Switch to dark theme";
    button.setAttribute("aria-label", text);
    button.title = text;
  };
  button.hidden = false;
  label();
  button.addEventListener("click", () => {
    const next = shown() === "dark" ? "light" : "dark";
    if (next === os()) delete root.dataset["theme"];
    else root.dataset["theme"] = next;
    try {
      if (next === os()) localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
    label();
  });
}

// The sticky header's height, so a jump to an anchor lands clear of it (global.css).
function headerHeight(): void {
  const header = document.querySelector<HTMLElement>(".site-header");
  if (!header || typeof ResizeObserver === "undefined") return;
  new ResizeObserver(() =>
    root.style.setProperty("--header-h", `${header.offsetHeight}px`),
  ).observe(header);
}

/** Examples name rbitcoin.space; on another server they name the one the reader is on. */
function localExamples(): void {
  if (location.origin === SITE || !/^https?:$/.test(location.protocol)) return;
  for (const code of document.querySelectorAll<HTMLElement>("pre.code code")) {
    code.textContent = (code.textContent ?? "").replaceAll(SITE, location.origin);
  }
}

/** A copy button on each code block, outside its scroller so it stays put while a line scrolls. */
function codeCopyButtons(): void {
  for (const pre of document.querySelectorAll<HTMLElement>("pre.code")) {
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(pre);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code__copy";
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent ?? "";
      void copy(code.replaceAll(/^\$ /gm, ""));
    });
    block.append(button);
  }
}

function pageMenu(): void {
  const actions = document.querySelector<HTMLElement>(".page-actions");
  const more = document.querySelector<HTMLButtonElement>(".split__more");
  const menu = document.querySelector<HTMLElement>("#page-menu");
  if (!actions || !more || !menu) return;
  actions.hidden = false;

  const ask = `Read ${SITE}${mdPath} and help me use the rbitcoin.space API it describes.`;
  const claude = menu.querySelector<HTMLAnchorElement>('[data-action="open-claude"]');
  const chatgpt = menu.querySelector<HTMLAnchorElement>('[data-action="open-chatgpt"]');
  if (claude) claude.href = `https://claude.ai/new?q=${encodeURIComponent(ask)}`;
  if (chatgpt) chatgpt.href = `https://chatgpt.com/?q=${encodeURIComponent(ask)}`;
  const cursor = menu.querySelector<HTMLAnchorElement>('[data-action="mcp-cursor"]');
  if (cursor) {
    const config = btoa(JSON.stringify({ url: mcpUrl }));
    cursor.href = `cursor://anysphere.cursor-deeplink/mcp/install?name=rbitcoin&config=${encodeURIComponent(config)}`;
  }

  const items = () =>
    [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
      (el) => el.offsetParent !== null,
    );
  const open = (focusFirst: boolean) => {
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    if (focusFirst) items()[0]?.focus();
  };
  const close = (refocus: boolean) => {
    if (menu.hidden === true) return;
    menu.hidden = true;
    more.setAttribute("aria-expanded", "false");
    if (refocus) more.focus();
  };
  // A click from the keyboard (Enter, Space) has no pointer, `detail` 0: focus goes into the menu.
  more.addEventListener("click", (e) =>
    menu.hidden === true ? open(e.detail === 0) : close(false),
  );
  more.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      open(true);
    }
  });
  // Escape closes it wherever focus is: on its button after a click, or on an item.
  actions.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.hidden !== true) {
      e.preventDefault();
      close(true);
    }
  });
  menu.addEventListener("keydown", (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === "Tab") close(false);
  });
  document.addEventListener("click", (e) => {
    if (e.target instanceof Node && !actions.contains(e.target)) close(false);
  });

  actions.addEventListener("click", (e) => {
    const target =
      e.target instanceof Element
        ? e.target.closest<HTMLElement>('[data-action], [role="menuitem"]')
        : null;
    const action = target?.dataset["action"];
    if (action === "copy") void copyPage("Page copied as Markdown");
    else if (action === "mcp-url") void copy(mcpUrl, "MCP server URL copied");
    else if (action === "mcp-claude-code") {
      void copy(`claude mcp add --transport http rbitcoin ${mcpUrl}`, "Command copied");
    } else if (!(target instanceof HTMLAnchorElement)) return;
    // From an item, focus goes back to the menu's button, where the reader left off (a link opens a
    // new tab or another app); the page's own Copy button keeps it.
    close(target?.getAttribute("role") === "menuitem");
  });
}

/** The MCP actions show only where this server runs MCP (`MCP_ENABLED`). */
async function mcpActions(): Promise<void> {
  try {
    const r = await fetch("/app/config");
    const config: unknown = await r.json();
    if (typeof config !== "object" || config === null || !("mcp" in config)) return;
    if (config.mcp !== true) return;
    for (const el of document.querySelectorAll<HTMLElement>('[data-needs="mcp"]'))
      el.hidden = false;
  } catch {
    // No answer: the MCP actions stay hidden.
  }
}

themeToggle();
headerHeight();
localExamples();
codeCopyButtons();
pageMenu();
void mcpActions();
