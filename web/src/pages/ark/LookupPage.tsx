// `/ark/vtxo/<txid>:<vout>`: asks every implementation the network has at once and opens the page
// of the one that knows the VTXO, in place of this one, so Back returns to the box.
import { useNavigate, useParams } from "@solidjs/router";
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js";
import { Link } from "../../components/Link";
import { Empty, ErrorState, Loading } from "../../components/States";
import { createRequest } from "../../lib/api";
import { loadConfig } from "../../lib/config";
import { isNetwork, onNetwork, paths } from "../../lib/network";
import { useNetwork, usePageTitle } from "../../lib/page";
import { parseOutpoint } from "./arkade/vtxo";
import { ask, names, offered, verdict } from "./lookup";
import "./Ark.css";

export default function LookupPage() {
  usePageTitle(() => "Ark VTXO");
  const params = useParams<{ id: string }>();
  const network = useNetwork();
  const navigate = useNavigate();
  const outpoint = createMemo(() => parseOutpoint(params.id ?? ""));
  const id = () => {
    const o = outpoint();
    return o ? `${o.txid}:${o.vout}` : undefined;
  };
  const [config] = createRequest(() => true, loadConfig);
  const impls = createMemo(() => offered(config()?.ark[network()]));
  // A string, so the same lookup worked out again asks nothing.
  const key = createMemo(() => {
    const i = id();
    return i === undefined || config.loading || impls().length === 0
      ? false
      : `${network()} ${i} ${impls()
          .map((m) => m.id)
          .join(",")}`;
  });
  const [answers, { refetch }] = createRequest(key, async (k, signal) => {
    const [n = "", txid = "", vout = ""] = k.replace(":", " ").split(" ");
    const net = isNetwork(n) ? n : "mainnet";
    const list = impls();
    return {
      net,
      list,
      verdict: verdict(
        list,
        await Promise.all(list.map((m) => ask(net, m, txid, Number(vout), signal))),
      ),
    };
  });

  createEffect(answers, (a) => {
    const i = id();
    if (a?.verdict.kind === "one" && i !== undefined) {
      navigate(onNetwork(a.net, a.verdict.impl.page(i)), { replace: true });
    }
  });

  return (
    <div class="wrap ark-lookup">
      <Link class="ark-lookup__back tap" href={paths.ark()}>
        ← Another VTXO
      </Link>
      <h1>VTXO</h1>
      <Show when={id()} fallback={<Empty title="Not a VTXO ID" />}>
        {(i) => (
          <>
            <p class="ark-lookup__id mono">{i()}</p>
            <Switch fallback={<Loading label={`Asking ${names(impls(), "and")}`} />}>
              <Match when={!config.loading && impls().length === 0}>
                <Empty title="No Ark server is set up on this network" />
              </Match>
              <Match when={answers.state === "ready" ? answers()?.verdict : undefined}>
                {(v) => (
                  <Switch>
                    <Match when={v().kind === "many" ? v() : undefined}>
                      {(many) => <Choice ids={many()} id={i()} />}
                    </Match>
                    <Match when={v().kind === "none" ? v() : undefined}>
                      {(none) => (
                        <NotFound verdict={none()} all={answers()?.list ?? []} retry={refetch} />
                      )}
                    </Match>
                  </Switch>
                )}
              </Match>
            </Switch>
          </>
        )}
      </Show>
    </div>
  );
}

type Verdict = ReturnType<typeof verdict>;

/** More than one implementation knows it, which should not happen: neither is preferred. */
function Choice(props: { ids: Verdict; id: string }) {
  const list = () => (props.ids.kind === "many" ? props.ids.impls : []);
  return (
    <Empty title={`Known to ${names(list(), "and")}`}>
      <div class="ark-lookup__choice">
        <For each={list()}>
          {(m) => (
            <Link class="btn" href={m.page(props.id)}>
              {m.name}
            </Link>
          )}
        </For>
      </div>
    </Empty>
  );
}

/** None knows it; any that could not be asked are named, with a retry. */
function NotFound(props: { verdict: Verdict; all: ReturnType<typeof offered>; retry: () => void }) {
  const down = () => (props.verdict.kind === "none" ? props.verdict.down : []);
  const unknown = () => props.all.filter((m) => !down().includes(m));
  return (
    <Show
      when={down().length > 0}
      fallback={<Empty title={`Not found on ${names(props.all, "or")}`} />}
    >
      <ErrorState
        title={`${names(down(), "and")} could not be reached`}
        message={
          unknown().length > 0
            ? `Not found on ${names(unknown(), "or")}.`
            : "Try again in a moment."
        }
        retry={props.retry}
      />
    </Show>
  );
}
