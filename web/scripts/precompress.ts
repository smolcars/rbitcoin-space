import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * Writes .br and .gz beside each text file in the build; the server sends them to clients that
 * accept them. Only files written since this build started: the docs build (vite.docs.config.ts)
 * adds to the explorer's output and leaves the explorer's files as they were compressed.
 */
export function precompress(): Plugin {
  let outDir = "";
  let started = 0;
  return {
    name: "precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      // Whole seconds: some file systems keep a file's time to the second.
      started = Math.floor(Date.now() / 1000) * 1000;
    },
    closeBundle() {
      for (const file of readdirSync(outDir, { recursive: true, encoding: "utf8" })) {
        if (!/\.(js|css|html|svg|json|txt|md)$/.test(file)) continue;
        const path = join(outDir, file);
        if (statSync(path).mtimeMs < started) continue;
        const data = readFileSync(path);
        const br = brotliCompressSync(data, {
          params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
        });
        const gz = gzipSync(data, { level: 9 });
        // A variant no smaller is not kept, nor one left from an earlier build of the file.
        if (br.length < data.length) writeFileSync(`${path}.br`, br);
        else rmSync(`${path}.br`, { force: true });
        if (gz.length < data.length) writeFileSync(`${path}.gz`, gz);
        else rmSync(`${path}.gz`, { force: true });
      }
    },
  };
}
