import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

const TEXT = /\.(js|css|html|svg|json|txt|md)$/;

function compress(path: string): void {
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

/**
 * Writes .br and .gz beside each text file in the build; the server sends them to clients that
 * accept them. The explorer's build compresses everything in its output, the files it copies from
 * public/ among them; the docs build (`own: true`) only the files it wrote itself, as it adds to the
 * explorer's output.
 */
export function precompress(options: { own?: boolean } = {}): Plugin {
  let outDir = "";
  // The browser tests serve the build as it is (scripts/e2e.sh): no copies to make.
  const off = process.env["PRECOMPRESS"] === "0";
  return {
    name: "precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle(_, bundle) {
      if (off || options.own !== true) return;
      for (const file of Object.keys(bundle)) if (TEXT.test(file)) compress(join(outDir, file));
    },
    closeBundle() {
      if (off || options.own === true) return;
      for (const file of readdirSync(outDir, { recursive: true, encoding: "utf8" })) {
        if (TEXT.test(file)) compress(join(outDir, file));
      }
    },
  };
}
