import { type Accessor, Show } from "solid-js";
import { Link } from "../components/Link";
import { paths } from "../lib/network";
import { Logo } from "./Logo";
import "./Footer.css";

export function Footer(props: {
  version: Accessor<string | undefined>;
  broadcast: Accessor<boolean | undefined>;
}) {
  return (
    <footer class="site-footer">
      <div class="site-footer__inner">
        <div class="site-footer__brand">
          <Logo />
          <p>
            <span class="site-footer__name">rbitcoin.space</span>
            <span class="muted">A block explorer for rbitcoin.</span>
          </p>
        </div>
        <div class="site-footer__row">
          <nav class="site-footer__links" aria-label="More">
            {/* The same page from every network: `onNetwork` leaves `/decode` unprefixed. */}
            <Link class="tap" href={paths.decode()}>
              Decoder
            </Link>
            {/* On the page's own network; the blocks it checks are always mainnet's. */}
            <Link class="tap" href={paths.timestamp()}>
              Timestamps
            </Link>
            {/* On the page's own network, and only where the server sends transactions. */}
            <Show when={props.broadcast()}>
              <Link class="tap" href={paths.push()}>
                Broadcast
              </Link>
            </Show>
            {/* The public docs are pages of their own, outside the app: the router lets them load. */}
            <a class="tap" href="/docs" rel="external">
              Docs
            </a>
            <a
              class="tap"
              href="https://github.com/smolcars/rbitcoin-space"
              rel="noopener noreferrer"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
              </svg>
              GitHub
            </a>
          </nav>
          {/* At the row's far end, so its late arrival moves nothing. */}
          <Show when={props.version()}>
            {(v) => <span class="site-footer__version muted mono">v{v()}</span>}
          </Show>
        </div>
      </div>
    </footer>
  );
}
