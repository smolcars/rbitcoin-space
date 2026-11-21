// The decoder's answers for public test vectors (fixtures/decode/answers.json, which the server's
// test holds equal to what it writes), served in place of `POST /app/decode`, with hostile
// variants made to break a layout. Shared by decode.e2e.ts and the page sweeps (pages.ts).
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

type Answer = Record<string, unknown>;

export const ANSWERS = JSON.parse(
  readFileSync(new URL("../../fixtures/decode/answers.json", import.meta.url), "utf8"),
) as Record<string, Answer>;

const RTL = "‫عقدةالبرقالسريعة‬";
const EMOJI = "⚡🐙🦀⚡🐙🦀⚡🐙";
const WORD = "a".repeat(120);

/** The worst text a string can carry, in every free-text field the page draws. */
export function hostile(): Record<string, Answer> {
  const invoice = ANSWERS["bolt11"] as Answer & { hints: Answer[][] };
  const description = `${RTL} ${EMOJI} ${WORD} ${"Coffee and cake, ".repeat(28)}`.slice(0, 600);
  const hop = invoice.hints[0]?.[0] ?? {};
  const named = { ...(hop["node"] as Answer), alias: `${RTL}${EMOJI}${"N".repeat(32)}` };
  const offer = ANSWERS["offer"] as Answer;
  const host = "xn--bitcin-6ya.example";
  const url = `https://${host}/${"p".repeat(1800)}?tag=login&k1=${"ab".repeat(32)}`;
  return {
    "a long invoice": {
      ...invoice,
      amount_msat: 2_100_000_000_000_000_000,
      description,
      description_hash: null,
      hints: [[{ ...hop, node: named }, ...(invoice.hints[0] ?? []).slice(1)], ...invoice.hints],
    },
    // Over a bitcoin with a fraction of a sat: sats to the msat, the longest a JSON number keeps.
    "a long fractional invoice": { ...invoice, amount_msat: 9_007_199_254_739_001 },
    "a long offer": { ...offer, description, issuer: `${EMOJI}${WORD}` },
    "a long LNURL": { ...ANSWERS["lnurl"], url, host, tag: "login", k1: "ab".repeat(32) },
    "a long address": {
      ...ANSWERS["lightning_address"],
      name: "n".repeat(200),
      domain: `${"sub.".repeat(20)}example.com`,
      url: `https://${"sub.".repeat(20)}example.com/.well-known/lnurlp/${"n".repeat(200)}`,
    },
  };
}

/** Every recorded answer, then the hostile ones, by a name for the test. */
export const allAnswers = (): Record<string, Answer> => ({ ...ANSWERS, ...hostile() });

/**
 * Answers `POST /app/decode` with `answer()` at the time of each request, so one loaded page can
 * be shown each kind. Anything but a POST is passed on.
 */
export async function serveDecode(
  page: Page,
  answer: () => Answer | { status: number; error: string },
) {
  // No decoder test leaves this machine: a service an LNURL or address names refuses, unless a
  // test routes it itself (a later route wins).
  await page.route(/^https:\/\//, (route) =>
    route.fulfill({
      json: { status: "ERROR", reason: "stub" },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.route(/\/app\/decode$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const a = answer();
    return "status" in a && typeof a.status === "number"
      ? route.fulfill({ status: a.status, json: { error: a.error } })
      : route.fulfill({ json: a });
  });
}

/** The named invoice, for the page sweeps. */
export const withInvoice = (page: Page) => serveDecode(page, () => ANSWERS["bolt11"] ?? {});
