// What this server serves, from GET /app/config (crates/server/src/app_config.rs).
import { isNetwork, type Network } from "./network";

export interface AppConfig {
  /** Enabled networks, in the server's order. */
  networks: Network[];
  version: string;
  /** The Ark implementations each network looks VTXOs up on (`bark`), only where it has one. */
  ark: Partial<Record<Network, string[]>>;
}

/** The `ark` map: known networks, each with a list of short lower-case names. */
function parseArk(v: unknown): Partial<Record<Network, string[]>> {
  const out: Partial<Record<Network, string[]>> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [network, list] of Object.entries(v)) {
    if (!isNetwork(network) || !Array.isArray(list)) continue;
    const names = list.filter((n): n is string => typeof n === "string" && /^[a-z]{1,20}$/.test(n));
    if (names.length > 0) out[network] = names;
  }
  return out;
}

/** Reads the reply, keeping only known networks. The body is untrusted until checked. */
export function parseConfig(body: unknown): AppConfig | null {
  if (typeof body !== "object" || body === null) return null;
  const networks = "networks" in body && Array.isArray(body.networks) ? body.networks : null;
  if (!networks) return null;
  const version = "version" in body && typeof body.version === "string" ? body.version : "";
  const ark = parseArk("ark" in body ? body.ark : undefined);
  // oxlint-disable-next-line unicorn/no-array-callback-reference -- isNetwork takes one argument
  return { networks: networks.filter(isNetwork), version, ark };
}

/**
 * The server's config, or null when it cannot be had; the shell then offers only the current
 * network. Never from a cache: the shell compares versions to tell when the site was updated.
 */
export async function fetchConfig(): Promise<AppConfig | null> {
  try {
    const res = await fetch("/app/config", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    return res.ok ? parseConfig(await res.json()) : null;
  } catch {
    return null;
  }
}

let first: Promise<AppConfig | null> | undefined;

/** Asks for the config and keeps the answer for {@link loadConfig}. The shell asks once, on load. */
export function readConfig(): Promise<AppConfig | null> {
  first = fetchConfig();
  return first;
}

/**
 * The config as the shell read it, for pages that need what the server offers (the Ark pages);
 * asked now if the shell has not. {@link fetchConfig} always asks again.
 */
export function loadConfig(): Promise<AppConfig | null> {
  first ??= fetchConfig();
  return first;
}
