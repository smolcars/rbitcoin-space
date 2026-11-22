// `bun run build [vite flags]`: the explorer's build with the flags as given, then the public docs'
// build (vite.docs.config.ts) into the same directory, which it adds to and never empties. A caller
// that names an output directory (scripts/e2e.sh) gets both builds there.
import { spawnSync } from "node:child_process";

const flags = process.argv.slice(2);
const vite = (args: string[]): void => {
  const run = spawnSync("vite", ["build", ...args], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
};
vite(flags);
// Vite reads `--emptyOutDir` and `--empty-out-dir` alike, with or without `=value`.
const empties = (f: string) => /^--empty-?out-?dir(=|$)/i.test(f);
vite(["--config", "vite.docs.config.ts", ...flags.filter((f) => !empties(f))]);
