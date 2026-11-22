// `bun run build [vite flags]`: the explorer's build with the flags as given, then the public docs'
// build (vite.docs.config.ts) into the same directory, which it adds to and never empties. The docs
// build takes only where to write and how much to say (scripts/e2e.sh names both): any other flag
// is the explorer build's, and passed on it could take a value for the docs build's root.
import { spawnSync } from "node:child_process";

const flags = process.argv.slice(2);
const vite = (args: string[]): void => {
  const run = spawnSync("vite", ["build", ...args], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
};

/** The flags named, with their values, as `--name value` or `--name=value`. */
function only(names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? "";
    // After `--` nothing is a flag to Vite.
    if (flag === "--") break;
    const name = flag.split("=", 1)[0] ?? "";
    if (!names.includes(name)) continue;
    if (flag.includes("=")) out.push(flag);
    else {
      out.push(flag, flags[i + 1] ?? "");
      i += 1;
    }
  }
  return out;
}

vite(flags);
// Asked only for the usage, Vite printed it and built nothing: neither does the docs build.
if (flags.some((f) => f === "--help" || f === "-h")) process.exit(0);
vite([
  "--config",
  "vite.docs.config.ts",
  ...only(["--outDir", "--out-dir", "--logLevel", "--log-level", "-l"]),
]);
