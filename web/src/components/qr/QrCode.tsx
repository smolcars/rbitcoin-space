import { createMemo, Show } from "solid-js";
import { LogoParts } from "../../shell/Logo";
import { drawingFor, findersPath, inkFor, modulesPath, QUIET } from "./draw";

/** A token's value on the page, or "" where there is none (a test's document). */
const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * `text` as a QR code at level Q, dark on a light card `px` wide: soft, with the logo in the middle,
 * where the card gives the code the pixels for it, and plain where it does not (draw.ts). `colour`
 * (a node's, `#rrggbb` already checked) draws it, darkened if it is too pale to scan. Says so in a
 * line under it when `colour` is given, or null for none announced.
 */
export function QrCode(props: { text: string; label: string; px: number; colour?: string | null }) {
  const drawing = createMemo(() => drawingFor(props.text, props.px));
  const code = () => drawing()?.code;
  const mark = () => drawing()?.mark ?? null;
  const soft = () => drawing()?.soft ?? false;
  const ink = createMemo(() =>
    inkFor(props.colour ?? null, token("--qr-paper") || "#fff", token("--qr-ink") || "#000"),
  );
  return (
    <Show when={code()} fallback={<p class="qr__none">This is too long to show as a QR code.</p>}>
      {(c) => {
        const box = () => c().size + 2 * QUIET;
        return (
          <>
            <div class="qr__card" style={{ "--qr-use": ink().colour }}>
              <svg
                class="qr__code"
                viewBox={`0 0 ${box()} ${box()}`}
                role="img"
                aria-label={props.label}
                data-drawing={mark() ? "logo" : soft() ? "soft" : "plain"}
                data-px={props.px}
              >
                <path d={modulesPath(c(), mark(), soft())} />
                <path d={findersPath(c().size, soft())} fill-rule="evenodd" />
                <Show when={mark()}>
                  {(m) => {
                    const k = m();
                    return k.kind === "logo" ? (
                      <svg
                        class="qr__mark"
                        x={k.x}
                        y={k.x}
                        width={k.size}
                        height={k.size}
                        viewBox="0 0 64 64"
                      >
                        <LogoParts />
                      </svg>
                    ) : (
                      // The logo's units, its block's middle on the pattern's and the crab's eyes
                      // just under it; the arriving layer one row above the pattern.
                      <g
                        class="qr__mark"
                        transform={`translate(${k.x} ${k.x}) scale(${k.scale}) translate(-32 -10.7)`}
                      >
                        <LogoParts strata={false} />
                        <rect class="logo__top" x="27" y="-10.2" width="18" height="4.2" rx="1.6" />
                      </g>
                    );
                  }}
                </Show>
              </svg>
            </div>
            <Show when={props.colour !== undefined}>
              <p class="qr__note">
                <Show when={props.colour}>
                  {(raw) => <span class="qr__swatch" style={{ "--qr-raw": raw() }} />}
                </Show>
                {ink().from === "colour"
                  ? "Drawn in the node's own colour"
                  : ink().from === "darkened"
                    ? "Drawn in the node's colour, darkened so it scans"
                    : "The node announces no colour"}
              </p>
            </Show>
          </>
        );
      }}
    </Show>
  );
}
