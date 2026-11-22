import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";
import { precompress } from "./scripts/precompress";

// The dev server proxies the Rust server, found where the server itself listens.
const server = `http://${process.env["LISTEN_ADDR"] ?? "127.0.0.1:8080"}`;

export default defineConfig({
  plugins: [solid(), precompress()],
  // The timestamp page's tests read real proofs from fixtures/ots as bytes (`?inline`).
  assetsInclude: ["**/*.ots"],
  // happy-dom gives component tests a DOM; pure-logic tests run in it unchanged.
  // The contrast test reads the tokens as text (src/styles/contrast.test.ts), and the palette's
  // test its stylesheet (src/palette/style.test.ts).
  test: { environment: "happy-dom", css: { include: [/tokens\.css/, /palette\/Palette\.css/] } },
  // No data: URIs, so the strict CSP (default-src 'self') holds for every asset.
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // The shell (the entry module and everything it imports, Solid's runtime among it), the
        // live channel, the topics the home page reads and the small components most pages use
        // travel as one file, loaded with the shell. Split by which pages share them, they were 14
        // more files on a cold page, and on a slow network each waits its turn for one of the
        // browser's six connections. With the entry module in it, all the shell's styles are one
        // stylesheet as well: the only one index.html links, and the one that sets the layer order.
        codeSplitting: {
          groups: [
            {
              name: "app",
              test: /\/src\/(index\.tsx|lib\/(live|blocks-topic|projected-topic|clock)\.ts|components\/(Amount|DataTable|FeeRate|Hash|Note|SectionHeader|Strata|Time|qr\/QrButton)\.tsx)$/,
            },
          ],
        },
      },
    },
  },
  server: {
    // The tokens and font live in design/, beside web/.
    fs: { allow: [".."] },
    proxy: {
      // Every network has its own API under its prefix.
      "^(/(signet|testnet4|testnet5|regtest))?/(api|app)(/|$)": { target: server, ws: true },
      "/healthz": server,
    },
  },
});
