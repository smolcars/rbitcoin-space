import { Show } from "solid-js";

/**
 * The mark: a crab lifting a block of settled strata, the top layer still arriving.
 * The crab and the settled layers take the network color, the arriving layer the accent.
 */
export function Logo() {
  return (
    <svg class="logo" viewBox="0 0 64 64" aria-hidden="true">
      <LogoParts />
    </svg>
  );
}

/** The mark's shapes in its 64-unit box; without `strata`, the crab alone (a QR code's middle). */
export function LogoParts(props: { strata?: boolean }) {
  return (
    <>
      <Show when={props.strata !== false}>
        <rect x="19" y="18" width="26" height="5.5" rx="1.6" />
        <rect class="logo__mid" x="19" y="11" width="26" height="5.5" rx="1.6" />
        <rect class="logo__top" x="27" y="4" width="18" height="5.5" rx="1.6" />
      </Show>
      <g class="logo__lines" stroke-linecap="round" stroke-linejoin="round">
        <path stroke-width="3.2" d="M20 40C13 37 10 33 10 28M44 40C51 37 54 33 54 28" />
        <path stroke-width="2.4" d="M28 35 27 30M36 35 37 30" />
        <path
          stroke-width="3"
          d="M20 45 12 47 8 53M22 49 15 53 13 59M26 51 22 57 22 61M44 45 52 47 56 53M42 49 49 53 51 59M38 51 42 57 42 61"
        />
      </g>
      <path d="M9.5 31C3 27 3 14 10.5 9.5 13.5 7.8 17 8 20 9.5L14 15.8 19.5 20.5C18 26 14.5 30 9.5 31ZM54.5 31C61 27 61 14 53.5 9.5 50.5 7.8 47 8 44 9.5L50 15.8 44.5 20.5C46 26 49.5 30 54.5 31ZM24.7 28.6a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0ZM34.7 28.6a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0ZM17 43C17 36 23 33 32 33 41 33 47 36 47 43 47 49 41 52 32 52 23 52 17 49 17 43Z" />
    </>
  );
}
