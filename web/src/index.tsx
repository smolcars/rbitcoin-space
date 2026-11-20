import { createRouter } from "@solidjs/router";
import { render } from "@solidjs/web";
import "../../design/tokens.css";
import "./styles/global.css";
import { watchFiles } from "./lib/chunks";
import { startLabels } from "./lib/labels/store";
import { routes } from "./routes";
import { Shell } from "./shell/Shell";

const FONT_WAIT_MS = 1000;

/**
 * Takes the web font out of the token font stacks for this page load, so a font that arrives
 * late never swaps in and reflows text. The next load finds it in the cache.
 */
function useFallbackFonts() {
  const root = document.documentElement;
  const tokens = getComputedStyle(root);
  for (const name of ["--font-sans", "--font-mono"]) {
    const stack = tokens
      .getPropertyValue(name)
      .replaceAll(/["']?Recursive [A-Za-z]+["']?\s*,\s*/g, "");
    root.style.setProperty(name, stack);
  }
}

const root = document.getElementById("root");
if (root) {
  watchFiles();
  // Lay text out once: in the preloaded font if it is here in time, otherwise in the fallbacks for good.
  // Prose is the system font; the web font sets hashes, addresses, numeric columns and digit gaps.
  // Both faces, though one file: a face first asked for after render (Firefox asks for the gap's
  // only when a page needs it) is a download that leaving the page cancels, and a late swap.
  const font = Promise.all([
    document.fonts.load('1em "Recursive Mono"'),
    document.fonts.load('1em "Recursive Gap"', "\u202F"),
  ])
    .then((faces) => faces.flat())
    .catch(() => []);
  const timeout = new Promise<[]>((resolve) => {
    setTimeout(() => resolve([]), FONT_WAIT_MS);
  });
  // WebKit runs this module before a stylesheet linked after it has loaded, and the build links
  // ours after it: the tokens read below (the fallback fonts, the theme colour) would be empty.
  const styled = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
    (link) =>
      link.sheet
        ? undefined
        : new Promise((resolve) => {
            link.addEventListener("load", resolve, { once: true });
            link.addEventListener("error", resolve, { once: true });
          }),
  );
  // The reader's own labels, read before the first render so they never arrive under a page
  // already drawn; within the font's wait, and nothing at all for a reader without labels.
  const labels = Promise.race([startLabels(), timeout]);
  void Promise.all([Promise.race([font, timeout]), labels, ...styled]).then(([faces]) => {
    if (!faces.some((f) => f.status === "loaded")) useFallbackFonts();
    // The browser restores scroll on back and forward, as it did before the router could.
    const Router = createRouter({ routes, scrollRestoration: false });
    render(() => <Router>{(page) => <Shell>{page.children}</Shell>}</Router>, root);
  });
}
