// A Bark VTXO from its serialized bytes (docs/ARK.md): the hex is in the fragment, which no
// server sees in a URL, and is sent in a POST body to be checked as a VTXO looked up by ID is.
import { useLocation } from "@solidjs/router";
import { Show } from "solid-js";
import { Link } from "../../../components/Link";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { ApiError, createRequest, postApp } from "../../../lib/api";
import { paths } from "../../../lib/network";
import { useNetwork, usePageTitle } from "../../../lib/page";
import { parseVtxo, readVtxoHex } from "./vtxo";
import { Body } from "./VtxoPage";
import "./Bark.css";

/** What the server's refusal means to a reader, and whether a retry could change it. */
function failure(e: unknown): { title: string; final: boolean } {
  if (e instanceof ApiError && e.status === 422) {
    return { title: "This VTXO did not check out", final: true };
  }
  if (e instanceof ApiError && (e.status === 400 || e.status === 413)) {
    return { title: "This hex is not a Bark VTXO", final: true };
  }
  return { title: "Could not check this VTXO", final: false };
}

export default function HexPage() {
  const location = useLocation();
  const network = useNetwork();
  const hex = () => readVtxoHex(location.hash);
  usePageTitle(() => "Bark VTXO");

  const [answer, { refetch }] = createRequest(
    () => {
      const h = hex();
      return h === null || h === "" ? false : ([network(), h] as const);
    },
    async ([n, h], signal) => {
      const parsed = parseVtxo(await postApp<unknown>(n, "/ark/bark/vtxo", h, { signal }));
      if (parsed === null) throw new ApiError(0, "The answer could not be read.");
      return parsed;
    },
  );

  return (
    <div class="wrap bark-page">
      <Link class="bark-page__back tap" href={paths.ark()}>
        ← Another VTXO
      </Link>
      <Show
        when={hex()}
        fallback={
          <>
            <h1>VTXO</h1>
            <Empty title={hex() === "" ? "No VTXO hex" : "Not VTXO hex"} />
          </>
        }
      >
        <Show
          when={answer.state !== "errored"}
          fallback={
            <>
              <h1>VTXO</h1>
              <Show
                when={!failure(answer.error).final}
                fallback={<Empty title={failure(answer.error).title} />}
              >
                <ErrorState
                  title={failure(answer.error).title}
                  error={answer.error}
                  retry={refetch}
                />
              </Show>
            </>
          }
        >
          <Show when={answer.latest} fallback={<Loading label="Checking the VTXO" />}>
            {(v) => <Body vtxo={v()} />}
          </Show>
        </Show>
      </Show>
    </div>
  );
}
