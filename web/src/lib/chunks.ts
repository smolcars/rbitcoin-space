// Code and styles loaded on demand, and what to do when they fail to download (docs/FRONTEND.md,
// "When a page's files fail to load").

/** Stylesheets whose download failed. Vite never asks for one again by itself. */
const failedStyles = new Set<HTMLLinkElement>();
/** Scripts whose `<link rel="modulepreload">` failed: Vite preloads a page's code and its imports. */
const failedScripts = new Set<string>();

/** Notes every stylesheet and script preload that fails from now on. Call once, before the first page loads. */
export function watchFiles(): void {
  // Capture: a load error does not bubble.
  document.addEventListener(
    "error",
    (e) => {
      if (!(e.target instanceof HTMLLinkElement)) return;
      if (e.target.rel === "stylesheet") failedStyles.add(e.target);
      else if (e.target.rel === "modulepreload") failedScripts.add(e.target.href);
    },
    true,
  );
}

/**
 * Notes a stylesheet as failed though no error was seen for it, so `retryFiles` asks for it again:
 * one whose rules a page found missing (the QR pop-up checks its own, components/qr/load.ts).
 */
export function noteFailedStyle(link: HTMLLinkElement): void {
  failedStyles.add(link);
}

/**
 * Asks again for every file that failed: each stylesheet through a fresh `<link>` in place of the
 * old, each script with a request that skips the cache, which only proves it downloads now (the
 * page's `import()` loads it). Waits for every one to settle. Resolves when all have loaded, with
 * whether any of them was a script; rejects when any failed again. Then each failed stylesheet and
 * every script is noted again, so the attempt that finally succeeds still says scripts were proven.
 */
export async function retryFiles(): Promise<{ scripts: boolean }> {
  const links = [...failedStyles];
  const scripts = [...failedScripts];
  failedStyles.clear();
  failedScripts.clear();
  const settled = await Promise.allSettled([
    ...links.map(
      (old) =>
        new Promise<void>((resolve, reject) => {
          const link = old.cloneNode() as HTMLLinkElement;
          link.addEventListener("load", () => resolve(), { once: true });
          link.addEventListener("error", () => reject(new Error(`Could not load ${link.href}`)), {
            once: true,
          });
          old.replaceWith(link);
        }),
    ),
    ...scripts.map(async (href) => {
      // Headers alone do not prove it: the whole body has to arrive.
      const ok = await fetch(href, { cache: "reload" })
        .then(async (res) => res.ok && (await res.arrayBuffer(), true))
        .catch(() => false);
      if (!ok) throw new Error(`Could not load ${href}`);
    }),
  ]);
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) {
    for (const href of scripts) failedScripts.add(href);
    throw failed.reason;
  }
  return { scripts: scripts.length > 0 };
}

/** Whether an error is a page's code or styles failing to download, as each browser words it. */
export function isChunkError(e: unknown): boolean {
  return (
    e instanceof Error &&
    /dynamically imported module|importing a module script failed|unable to preload css/i.test(
      e.message,
    )
  );
}

/** Automatic attempts before the reader is asked, and the wait before each: 1, 2 and 4 s. */
export const CHUNK_ATTEMPTS = 3;
export const chunkDelay = (attempt: number): number => 1000 * 2 ** attempt;

/** The shortest time between two reloads `reloadOnce` makes, so a file that never loads cannot loop. */
export const RELOAD_GAP_MS = 60_000;

/**
 * Reloads the page, unless this tab already did so in the last `RELOAD_GAP_MS`. WebKit keeps a
 * script that failed to download as failed for the life of the document, even once it downloads
 * again, so a fresh document is its only way to the page. Answers whether it reloaded; without
 * session storage it never does, since it could not tell a loop.
 */
export function reloadOnce(now = Date.now(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(sessionStorage.getItem("chunk-reload"));
    if (now - last < RELOAD_GAP_MS) return false;
    sessionStorage.setItem("chunk-reload", String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
