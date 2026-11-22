// The public docs' build, run after the explorer's into the same dist/ (`bun run build`). A build
// of its own, so the explorer's output is exactly what it would be without the docs: two pages in
// one build share Vite's preload polyfill as a file of its own, one more for a cold home page.
import { defineConfig } from "vite";
import { docs } from "./scripts/docs";
import { precompress } from "./scripts/precompress";

export default defineConfig({
  plugins: [docs(), precompress({ own: true })],
  // public/ is the explorer build's to copy.
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    // No data: URIs, so the strict CSP (default-src 'self') holds for every asset.
    assetsInlineLimit: 0,
    // The docs script preloads nothing.
    modulePreload: { polyfill: false },
    rolldownOptions: { input: "docs.html" },
  },
});
