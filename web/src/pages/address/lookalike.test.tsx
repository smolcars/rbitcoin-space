import { render } from "@solidjs/web";
import { describe, expect, it } from "vitest";
import type { Transaction, Vout } from "../../lib/esplora";
import { lookalikes, OWN_HEAD, PAIR_HEAD, summarize, TAIL } from "./lookalike";
import { KEPT_WHOLE, Marked } from "../../components/Lookalike";
import { budget } from "../../lib/budget";

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A small seeded generator, so a failure repeats. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const next = random(1);
const chars = (set: string, n: number) =>
  Array.from({ length: n }, () => set[Math.floor(next() * set.length)] ?? "").join("");

/**
 * An address of a form `recognise` takes (the checksum is not checked): `prefix`, then `head`, a
 * filler and `tail`, `length` characters in all. The filler starts with a character neither of two
 * addresses built with different heads can share by chance.
 */
function address(prefix: string, length: number, head: string, tail: string, set = BECH32) {
  return `${prefix}${head}${chars(set, length - prefix.length - head.length - tail.length)}${tail}`;
}
const p2wpkh = (head: string, tail: string) => address("bc1q", 42, head, tail);
const p2tr = (head: string, tail: string) => address("bc1p", 62, head, tail);

const out = (a: string): Vout => ({
  scriptpubkey: "",
  scriptpubkey_asm: "",
  scriptpubkey_type: "p2pkh",
  scriptpubkey_address: a,
  value: 546,
});
let n = 0;
const tx = (inputs: string[], outputs: string[]): Transaction => ({
  txid: (n++).toString(16).padStart(64, "0"),
  version: 2,
  locktime: 0,
  vin: inputs.map((a) => ({ txid: "a".repeat(64), vout: 0, is_coinbase: false, prevout: out(a) })),
  vout: outputs.map((a) => out(a)),
  status: { confirmed: true },
});

describe("lookalikes of the page's own address", () => {
  const own = "bc1qxyrkz6ug8wvn54fqq0uwh0wpr4nf5jt59s4rmc";
  it("flags a row naming one that agrees on the first two and last four", () => {
    const fake = `bc1qxy${"q".repeat(32)}4rmc`;
    const poison = tx([fake], [own, fake]);
    const found = lookalikes(own, [poison]).get(poison.txid);
    expect(found).toStrictEqual([
      { here: fake, like: own, own: true, head: 2, tail: 4, prefix: 4 },
    ]);
  });

  it("leaves one a character short at either end", () => {
    // A filler that differs from the own address where the threshold ends.
    const headShort = `bc1qxa${"q".repeat(32)}4rmc`;
    const tailShort = `bc1qxy${"q".repeat(32)}crmc`;
    expect(OWN_HEAD).toBe(2);
    expect(TAIL).toBe(4);
    expect(lookalikes(own, [tx([headShort, tailShort], [own])]).size).toBe(0);
  });

  it("never flags the page's own address, which every row names, nor a row naming it twice", () => {
    expect(lookalikes(own, [tx([own], [own]), tx([], [own])]).size).toBe(0);
  });

  it("compares base58 without case, as a glance reads it", () => {
    // Seen on mainnet: the second agrees with the first on "PW" only without case, and on "VzXU".
    const victim = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";
    const fake = "1PwjRJEUC2kxAapH1vcfqbguXigZeYVzXU";
    const t = tx([fake], [victim, fake]);
    expect(lookalikes(victim, [t]).get(t.txid)).toStrictEqual([
      { here: fake, like: victim, own: true, head: 2, tail: 4, prefix: 1 },
    ]);
  });

  it("leaves addresses that agree only at the start", () => {
    // Also on mainnet: ten leading characters ground to match, the ends different.
    const victim = "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU";
    const t = tx(
      ["1PWo3JeB9jzNsCi2EDT97FZsGciJGA7XNB", "1PWo3JeB92hdhCDhzGUTKWzXXAk4yyf8LZ"],
      [victim],
    );
    expect(lookalikes(victim, [t]).size).toBe(0);
  });

  it("covers P2SH and the test networks' forms", () => {
    const p2sh = `3Ab${"k".repeat(27)}WxYz`;
    const fakeSh = `3aB${"m".repeat(27)}wXyZ`;
    const t1 = tx([fakeSh], [p2sh]);
    expect(lookalikes(p2sh, [t1]).get(t1.txid)?.[0]?.like).toBe(p2sh);

    const tb = address("tb1q", 42, "dd", "zz9x");
    const fakeTb = `tb1qdd${"p".repeat(32)}zz9x`;
    const t2 = tx([], [tb, fakeTb]);
    expect(lookalikes(tb, [t2]).get(t2.txid)?.[0]?.here).toBe(fakeTb);

    const rt = address("bcrt1q", 44, "92", "mmx6");
    const fakeRt = `bcrt1q92${"s".repeat(32)}mmx6`;
    const t3 = tx([], [rt, fakeRt]);
    expect(lookalikes(rt, [t3]).get(t3.txid)?.[0]?.prefix).toBe(6);

    const testnet = address("m", 34, "wk", "Auat", BASE58);
    const fakeTest = `mWK${"1".repeat(27)}auat`;
    const t4 = tx([fakeTest], [testnet]);
    expect(lookalikes(testnet, [t4]).get(t4.txid)?.[0]?.tail).toBe(4);
  });

  it("never compares addresses of different kinds", () => {
    // Same visible ends, but P2WSH and P2WPKH, mainnet and regtest, P2PKH on mainnet and P2SH.
    const mine = `bc1qxy${"q".repeat(32)}4rmc`;
    const others = [
      `bc1qxy${"p".repeat(52)}4rmc`,
      `tb1qxy${"p".repeat(32)}4rmc`,
      `bc1pxy${"p".repeat(52)}4rmc`,
    ];
    expect(lookalikes(mine, [tx(others, [mine])]).size).toBe(0);
    const pkh = `1Ab${"z".repeat(27)}WXYZ`;
    expect(lookalikes(pkh, [tx([`3Ab${"z".repeat(27)}WXYZ`], [pkh])]).size).toBe(0);
  });

  it("never compares bech32 addresses of different lengths, nor pay to anchor", () => {
    // One future witness version, the same ends, programs of different lengths.
    const short = `bc1zxy${"q".repeat(30)}4rmc`;
    const long = `bc1zxy${"q".repeat(40)}4rmc`;
    expect(lookalikes(short, [tx([long], [short])]).size).toBe(0);
    expect(lookalikes(short, [tx([`bc1zxy${"p".repeat(30)}4rmc`], [short])]).size).toBe(1);
    // Pay to anchor is one fixed address: nothing looks like it, and it like nothing.
    // (The second has the form only: this rule reads forms, and its ends would agree.)
    const anchor = "bc1pfeessrawgf";
    expect(lookalikes(anchor, [tx(["bc1pfeesqqawgf"], [anchor])]).size).toBe(0);
  });

  it("covers the test networks' other base58 forms", () => {
    const pkh = `nWk${"1".repeat(27)}Auat`;
    const t1 = tx([`nwK${"2".repeat(27)}auAT`], [pkh]);
    expect(lookalikes(pkh, [t1]).get(t1.txid)?.[0]?.own).toBe(true);
    const two = `2Wk${"1".repeat(28)}Auat`;
    const t2 = tx([`2wK${"3".repeat(28)}auAT`], [two]);
    expect(lookalikes(two, [t2]).get(t2.txid)?.[0]?.own).toBe(true);
    // A testnet P2PKH and a testnet P2SH with the same ends are different kinds.
    expect(lookalikes(pkh, [tx([`2Wk${"1".repeat(27)}Auat`], [pkh])]).size).toBe(0);
  });
});

describe("lookalikes between other addresses in the history", () => {
  const own = "bc1qxyrkz6ug8wvn54fqq0uwh0wpr4nf5jt59s4rmc";

  it("flags both rows when two addresses agree on the first three and last four", () => {
    expect(PAIR_HEAD).toBe(3);
    const payee = `bc1pdcl${"q".repeat(51)}4uu7`;
    const fake = `bc1pdcl${"p".repeat(51)}4uu7`;
    const paid = tx([own], [payee]);
    const poison = tx([fake], [own]);
    const found = lookalikes(own, [poison, paid]);
    expect(found.get(paid.txid)).toStrictEqual([
      { here: payee, like: fake, own: false, head: 3, tail: 4, prefix: 4 },
    ]);
    expect(found.get(poison.txid)?.[0]?.like).toBe(payee);
  });

  it("is not run on a public key's page, whose findings the transaction page would not take", () => {
    const payee = `bc1pdcl${"q".repeat(51)}4uu7`;
    const fake = `bc1pdcl${"p".repeat(51)}4uu7`;
    const key = `02${"ab".repeat(32)}`;
    expect(lookalikes(key, [tx([fake], [own]), tx([own], [payee])]).size).toBe(0);
  });

  it("leaves two that agree on only two leading characters", () => {
    const payee = `bc1pdc${"q".repeat(52)}4uu7`;
    const other = `bc1pdc${"p".repeat(52)}4uu7`;
    expect(lookalikes(own, [tx([own], [payee]), tx([other], [own])]).size).toBe(0);
  });

  it("marks an earlier row again once a later page brings its lookalike", () => {
    const payee = p2tr("w0s", "k9hx");
    const paid = tx([own], [payee]);
    expect(lookalikes(own, [paid]).size).toBe(0);
    const later = tx([p2tr("w0s", "k9hx")], [own]);
    expect([...lookalikes(own, [paid, later]).keys()]).toStrictEqual([paid.txid, later.txid]);
  });

  it("leaves addresses that resemble one another only inside one transaction", () => {
    // Seen on mainnet: sixteen vanity addresses ground to "mullah0ut…5370", in one transaction.
    const batch = tx([], [p2wpkh("mullah0ut", "5370"), p2wpkh("mullah0ut", "5370"), own]);
    expect(lookalikes(own, [batch, tx([own], [p2tr("w0s", "k9hx")])]).size).toBe(0);
    // Once one of them appears in another transaction too, both rows say so.
    const again = tx([batch.vout[0]?.scriptpubkey_address ?? ""], [own]);
    expect(lookalikes(own, [batch, again]).size).toBe(2);
  });

  it("names as elsewhere only an address that is in another transaction", () => {
    // A and B look alike and share a transaction; A is paid again in another.
    const a = `bc1pdcl${"q".repeat(51)}4uu7`;
    const b = `bc1pdcl${"p".repeat(51)}4uu7`;
    const both = tx([own], [a, b]);
    const again = tx([own], [a]);
    const found = lookalikes(own, [both, again]);
    // Under the first row only B has a lookalike elsewhere (A, paid again); B is nowhere else.
    expect(found.get(both.txid)?.map((l) => [l.here, l.like])).toStrictEqual([[b, a]]);
    expect(found.get(again.txid)?.map((l) => [l.here, l.like])).toStrictEqual([[a, b]]);
  });

  it("finds the one address elsewhere however a bucket's addresses are spread", () => {
    // The bucket: A met in the first transaction and named again in the second, S only in the
    // second, B only in the third. Under the second row, A's lookalike elsewhere is B, though the
    // bucket's first two addresses (A itself, and S of this same row) cannot stand for it.
    const a = `bc1pdcl${"q".repeat(51)}4uu7`;
    const s = `bc1pdcl${"p".repeat(51)}4uu7`;
    const b = `bc1pdcl${"r".repeat(51)}4uu7`;
    const second = tx([own], [a, s]);
    const pairs = lookalikes(own, [tx([own], [a]), second, tx([own], [b])])
      .get(second.txid)
      ?.map((l) => [l.here, l.like]);
    expect(pairs).toStrictEqual([
      [a, b],
      [s, a],
    ]);
  });

  it("lists a lookalike of the page's own address before the others", () => {
    const payee = `bc1pdcl${"q".repeat(51)}4uu7`;
    const fakePayee = `bc1pdcl${"p".repeat(51)}4uu7`;
    const fakeOwn = `bc1qxy${"q".repeat(32)}4rmc`;
    const paid = tx([own], [payee]);
    const poison = tx([], [fakePayee, fakeOwn, own]);
    expect(
      lookalikes(own, [paid, poison])
        .get(poison.txid)
        ?.map((l) => l.own),
    ).toStrictEqual([true, false]);
  });

  it("says nothing for an address that is only repeated", () => {
    const payee = p2tr("w0s", "k9hx");
    expect(lookalikes(own, [tx([own], [payee]), tx([own], [payee, own])]).size).toBe(0);
  });
});

describe("a huge history", () => {
  const own = "bc1qxyrkz6ug8wvn54fqq0uwh0wpr4nf5jt59s4rmc";
  /** What a run may cost. A linear read costs about a sixth of it; a quadratic one, many times it. */
  const LIMIT_MS = 1000;
  /** For building 100,000 addresses and reading them on a machine with every core taken four times over. */
  const TIMEOUT_MS = 30_000;

  it(
    "reads 100,000 addresses in 40 transactions at once, and is quiet when none look alike",
    () => {
      const txs = Array.from({ length: 40 }, () =>
        tx(
          [own],
          Array.from({ length: 2500 }, () => p2wpkh("", "")),
        ),
      );
      const found = budget(LIMIT_MS, () => lookalikes(own, txs));
      // Random addresses: about 100,000² / 2 / 32^7 = 0.15 chance of a pair agreeing by luck.
      expect(found.size).toBeLessThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  it(
    "stays linear when a transaction's dust outputs all share one pair of ends",
    () => {
      const dust = tx(
        [own],
        Array.from({ length: 50_000 }, () => p2tr("dcl", "4uu7")),
      );
      const paid = tx([own], [p2tr("dcl", "4uu7")]);
      const found = budget(LIMIT_MS, () => lookalikes(own, [dust, paid]));
      expect(found.get(dust.txid)).toHaveLength(50_000);
      expect(found.get(paid.txid)).toHaveLength(1);
    },
    TIMEOUT_MS,
  );
});

describe("the summary the page's notice reads", () => {
  const own = "bc1qxyrkz6ug8wvn54fqq0uwh0wpr4nf5jt59s4rmc";
  const fake = `bc1qxy${"q".repeat(32)}4rmc`;
  const fake2 = `bc1qxy${"p".repeat(32)}4rmc`;

  it("is nothing for a history without lookalikes", () => {
    expect(summarize(lookalikes(own, [tx([own], [p2tr("w0s", "k9hx")])]))).toBeUndefined();
  });

  it("counts transactions, those of the own address, and different lookalikes of it", () => {
    const payee = `bc1pdcl${"q".repeat(51)}4uu7`;
    const paid = tx([own], [payee]);
    const a = tx([fake], [own]);
    const b = tx([fake, fake2], [own]);
    const c = tx([`bc1pdcl${"p".repeat(51)}4uu7`], [own]);
    const s = summarize(lookalikes(own, [paid, a, b, c]));
    expect(s?.txs).toBe(4);
    expect(s?.ownTxs).toBe(2);
    expect(s?.ownAddresses).toBe(2);
    expect(s?.own?.here).toBe(fake);
    // The first in list order, newest first: where the notice takes the reader.
    expect(s?.first).toBe(paid.txid);
  });
});

describe("an agreeing end too long for one line", () => {
  it("is marked so it may break, and a short one is not", () => {
    const el = document.createElement("div");
    const dispose = render(
      () => <Marked address={`bc1q${"q".repeat(58)}`} prefix={4} head={45} tail={4} />,
      el,
    );
    const agree = [...el.querySelectorAll(".lookalike__agree")];
    expect(agree.map((e) => e.textContent?.length)).toStrictEqual([45, 4]);
    expect(agree.map((e) => e.classList.contains("lookalike__agree--long"))).toStrictEqual([
      true,
      false,
    ]);
    expect(KEPT_WHOLE).toBe(12);
    dispose();
  });
});
