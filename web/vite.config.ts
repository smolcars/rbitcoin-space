import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

// The dev server proxies the Rust server, found where the server itself listens.
const server = `http://${process.env["LISTEN_ADDR"] ?? "127.0.0.1:8080"}`;

// Writes .br and .gz beside each text file in the build; the server sends them to clients that accept them.
function precompress(): Plugin {
  let outDir = "";
  return {
    name: "precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const file of readdirSync(outDir, { recursive: true, encoding: "utf8" })) {
        if (!/\.(js|css|html|svg|json|txt)$/.test(file)) continue;
        const path = join(outDir, file);
        const data = readFileSync(path);
        const br = brotliCompressSync(data, {
          params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
        });
        const gz = gzipSync(data, { level: 9 });
        if (br.length < data.length) writeFileSync(`${path}.br`, br);
        if (gz.length < data.length) writeFileSync(`${path}.gz`, gz);
      }
    },
  };
}

export default defineConfig({
  plugins: [solid(), precompress()],
  // happy-dom gives component tests a DOM; pure-logic tests run in it unchanged.
  // The contrast test reads the tokens as text (src/styles/contrast.test.ts).
  test: { environment: "happy-dom", css: { include: [/tokens\.css/] } },
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
              test: /\/src\/(index\.tsx|lib\/(live|blocks-topic|projected-topic|clock)\.ts|components\/(Amount|DataTable|FeeRate|Hash|SectionHeader|Strata|Time)\.tsx)$/,
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
