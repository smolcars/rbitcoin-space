import { type Accessor, Show } from "solid-js";
import { Link } from "../components/Link";
import { paths } from "../lib/network";
import "./Footer.css";

export function Footer(props: {
  version: Accessor<string | undefined>;
  broadcast: Accessor<boolean | undefined>;
}) {
  return (
    <footer class="site-footer">
      <div class="site-footer__inner">
        <p>rbitcoin.space, a block explorer for rbitcoin.</p>
        {/* The same page from every network: `onNetwork` leaves `/decode` unprefixed. */}
        <p>
          <Link class="tap" href={paths.decode()}>
            Decoder
          </Link>
        </p>
        {/* On the page's own network, and only where the server sends transactions. */}
        <Show when={props.broadcast()}>
          <p>
            <Link class="tap" href={paths.push()}>
              Broadcast
            </Link>
          </p>
        </Show>
        <p>
          <a
            class="tap"
            href="https://github.com/smolcars/rbitcoin-space"
            rel="noopener noreferrer"
          >
            Source code
          </a>
          {/* Last on the page, so its late arrival moves nothing. */}
          <Show when={props.version()}>
            {(v) => <span class="muted num">, version {v()}</span>}
          </Show>
        </p>
      </div>
    </footer>
  );
}
