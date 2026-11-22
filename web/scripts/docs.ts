// Vite plugin for the public docs (docs/FRONTEND.md "Public docs"). Vite builds web/docs.html as a
// second page, linking its own script and stylesheet; this plugin takes that built page as the
// template, fills it once per Markdown page in web/docs/, and adds the Markdown copies and
// /llms.txt. The template itself is not shipped.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { build } from "../src/docs/build";
import { PAGES } from "../src/docs/pages";

export function docs(): Plugin {
  let root = "";
  return {
    name: "docs",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle: {
      // After Vite's own HTML plugin has written the template's links to the hashed files.
      order: "post",
      handler(_, bundle) {
        const template = bundle["docs.html"];
        if (template?.type !== "asset" || typeof template.source !== "string") {
          this.error("docs: the build has no docs.html");
        }
        const sources = new Map<string, string>();
        for (const p of PAGES) {
          const file = resolve(root, "docs", `${p.slug === "" ? "index" : p.slug}.md`);
          this.addWatchFile(file);
          sources.set(p.slug, readFileSync(file, "utf8"));
        }
        // The API's version is the server's: the workspace's, in Cargo.toml beside web/.
        const manifest = resolve(root, "..", "Cargo.toml");
        this.addWatchFile(manifest);
        const cargo = readFileSync(manifest, "utf8");
        const workspace = cargo.slice(cargo.indexOf("[workspace.package]"));
        const version = /^version = "([^"]+)"/m.exec(workspace)?.[1];
        if (version === undefined) this.error("docs: no version in Cargo.toml");
        const html = template.source;
        delete bundle["docs.html"];
        for (const [fileName, source] of build(html, sources, version)) {
          this.emitFile({ type: "asset", fileName, source });
        }
      },
    },
  };
}
