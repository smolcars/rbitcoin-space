#!/usr/bin/env python3
"""Private rbitcoin regtest node in Docker. Needs only docker and python3.

rbitcoin has no wallet, so every coin here sits in an anyone-can-spend script
and transactions are built and serialized by hand: no keys, no signatures.
Usage is in docs/REGTEST.md; `regtest.py -h` lists the commands.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
COMPOSE = os.path.join(HERE, "compose.yml")
USER = PASSWORD = "regtest"  # throwaway; must match the cookie in compose.yml
PORTS = {"rpc": 18443, "esplora": 3000, "electrum": 50001}  # container side
T0 = 1767225600  # 2026-01-01T00:00:00Z. Fixed block times make the scenario's hashes repeatable.


def sha256(b):
    return hashlib.sha256(b).digest()


# The project's old name stays here and in NOTE: those bytes seed every scenario hash the tests pin.
def tag(name):
    return sha256(b"mempool.based regtest " + name.encode())


# Scripts. Coins we spend later are anyone-can-spend; the rest pay to made-up
# keys and hashes that nobody holds, which is fine for display.
OP_TRUE = b"\x51"
MINER = b"\x00\x20" + sha256(OP_TRUE)  # P2WSH(OP_TRUE): spent with witness [OP_TRUE]
P2SH_TRUE = bytes.fromhex("a914da1745e9b549bd0bfa1a569971c77eba30cd5a4b87")  # P2SH(OP_TRUE), hash160(0x51)
P2A = bytes.fromhex("51024e73")  # pay-to-anchor: spent with nothing at all
P2PKH = b"\x76\xa9\x14" + tag("p2pkh")[:20] + b"\x88\xac"
P2WPKH = b"\x00\x14" + tag("p2wpkh")[:20]
P2WSH = b"\x00\x20" + tag("p2wsh")
P2TR = b"\x51\x20" + tag("p2tr")
NOTE = b"mempool.based regtest"
OP_RETURN = b"\x6a" + bytes([len(NOTE)]) + NOTE
UNLOCK = {MINER: (b"", [OP_TRUE]), P2SH_TRUE: (b"\x01" + OP_TRUE, []), P2A: (b"", [])}
# Text an attacker can put on chain, for the browser test that pages show it as inert text.
HOSTILE_NOTES = [
    b"<img src=x onerror=alert(1)>",
    b"javascript:alert(document.domain)",
    "\u202eevil\u202c \u2066rtl\u2069 \u200bzero-width".encode(),
    b"</title><script>alert(1)</script>",
    b"line1\nline2\r\n\x1b[31mANSI\x1b[0m\x00NUL",
]
HOSTILE_TAG = "<script>alert('cb')</script>\u202e <b>pool</b>".encode()
# Inscriptions an attacker can reveal: markup as text, JSON, and an SVG with a script, which a page
# must never draw. (content type, body)
HOSTILE_INSCRIPTIONS = [
    (b"text/html;charset=utf-8", "<script>alert('ins')</script>\u202e<img src=x onerror=alert(2)>".encode()),
    (b"application/json", b'{"p":"brc-20","op":"<b>mint</b>","tick":"\\u202e"}'),
    (b"image/svg+xml", b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(3)"/>'),
]


# --- docker -----------------------------------------------------------------


def project():
    # One instance per checkout by default, so builders in separate worktrees never collide.
    return os.environ.get("REGTEST_PROJECT") or "regtest-" + sha256(HERE.encode()).hex()[:8]


def compose(*args, capture=False):
    env = dict(os.environ, REGTEST_PROJECT=project())
    cmd = ["docker", "compose", "-f", COMPOSE, "-p", project(), *args]
    out = subprocess.PIPE if capture else None
    r = subprocess.run(cmd, env=env, text=True, stdout=out, stderr=out)
    if r.returncode:
        sys.exit(f"regtest: docker compose {args[0]} failed for {project()} (exit {r.returncode})")
    return r.stdout


_ports = {}


def port(name):
    if name not in _ports:
        if not compose("ps", "-q", "--status", "running", capture=True).strip():
            sys.exit(f"regtest: {project()} is not running; start it with `regtest.py up`")
        _ports[name] = int(compose("port", "node", str(PORTS[name]), capture=True).strip().rsplit(":", 1)[1])
    return _ports[name]


# --- node clients -----------------------------------------------------------


class RpcError(Exception):
    pass


def rpc(method, *params):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port('rpc')}/",
        data=json.dumps({"jsonrpc": "1.0", "id": 1, "method": method, "params": list(params)}).encode(),
        headers={
            "Authorization": "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode(),
            "Content-Type": "application/json",
        },
    )
    try:
        body = urllib.request.urlopen(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        body = e.read()  # JSON-RPC errors come back with HTTP 500
    r = json.loads(body, parse_float=Decimal)
    if r.get("error"):
        raise RpcError(f"{method}: {r['error']}")
    return r["result"]


def esplora(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port('esplora')}{path}", timeout=30) as r:
        return json.loads(r.read())


def electrum(method, *params):
    with socket.create_connection(("127.0.0.1", port("electrum")), timeout=30) as s:
        s.sendall((json.dumps({"id": 1, "method": method, "params": list(params)}) + "\n").encode())
        r = json.loads(s.makefile().readline())
    if r.get("error"):
        raise RpcError(f"{method}: {r['error']}")
    return r["result"]


def wait_ready(timeout=120):
    deadline = time.monotonic() + timeout
    while True:
        try:
            height = rpc("getblockcount")
            if esplora("/blocks/tip/height") == height and electrum("server.version", "regtest.py", "1.4"):
                return
        except (OSError, ValueError, RpcError, urllib.error.URLError):
            pass
        if time.monotonic() > deadline:
            compose("logs", "--tail", "40")
            sys.exit(f"regtest: not ready after {timeout} s")
        time.sleep(0.2)


# --- transactions -----------------------------------------------------------


def varint(n):
    if n < 0xFD:
        return bytes([n])
    return b"\xfd" + struct.pack("<H", n) if n <= 0xFFFF else b"\xfe" + struct.pack("<I", n)


def serialize(ins, outs, with_witness=True):
    """ins: (txid, vout, spk, sequence); outs: (spk, sats)."""
    unlock = [UNLOCK[spk] for _, _, spk, _ in ins]
    segwit = with_witness and any(w for _, w in unlock)
    b = struct.pack("<i", 2) + (b"\x00\x01" if segwit else b"") + varint(len(ins))
    for (txid, vout, _, seq), (script_sig, _) in zip(ins, unlock):
        b += bytes.fromhex(txid)[::-1] + struct.pack("<I", vout) + varint(len(script_sig)) + script_sig
        b += struct.pack("<I", seq)
    b += varint(len(outs))
    for spk, sats in outs:
        b += struct.pack("<q", sats) + varint(len(spk)) + spk
    if segwit:
        for _, wit in unlock:
            b += varint(len(wit)) + b"".join(varint(len(item)) + item for item in wit)
    return b + struct.pack("<I", 0)


def build(coins, outs, feerate, seq=0xFFFFFFFD):
    """coins: (txid, vout, spk, sats). Change goes back to MINER. Returns (txid, hex)."""
    ins = [(txid, vout, spk, seq) for txid, vout, spk, _ in coins]
    change = sum(c[3] for c in coins) - sum(sats for _, sats in outs)
    trial = outs + [(MINER, change)]
    base, full = len(serialize(ins, trial, False)), len(serialize(ins, trial))
    vsize = (base * 3 + full + 3) // 4
    change -= -(-int(vsize * feerate * 1000) // 1000)  # fee, rounded up
    if change < 0:
        sys.exit("regtest: inputs do not cover outputs and fee")
    final = outs + ([(MINER, change)] if change else [])
    return sha256(sha256(serialize(ins, final, False)))[::-1].hex(), serialize(ins, final).hex()


def broadcast(coins, outs, feerate, **kw):
    txid, raw = build(coins, outs, feerate, **kw)
    if rpc("sendrawtransaction", raw) != txid:
        sys.exit(f"regtest: node returned a different txid for {txid}")
    return txid


def take_coins(n=1):
    """The n oldest mature coinbases not yet spent (mempool included)."""
    coins, tip = [], rpc("getblockcount")
    for h in range(1, tip - 98):  # a coinbase needs 100 confirmations
        txid = rpc("getblock", rpc("getblockhash", h), 1)["tx"][0]
        out = rpc("gettxout", txid, 0, True)
        if out and out["scriptPubKey"]["hex"] == MINER.hex():
            coins.append((txid, 0, MINER, int(out["value"] * 100_000_000)))
            if len(coins) == n:
                return coins
    sys.exit("regtest: not enough mature coins; mine more blocks (a coinbase matures after 100)")


def mine(n):
    return rpc("generatetodescriptor", n, f"raw({MINER.hex()})")


def mine_at_fixed_times(n):
    hashes = []
    for _ in range(n):
        rpc("setmocktime", T0 + 600 * (rpc("getblockcount") + 1))
        hashes += mine(1)
    return hashes


# --- taproot ----------------------------------------------------------------
# Just enough secp256k1 to commit to a script: the internal key is the generator, so the output key
# is (1 + tweak)·G. Nobody signs anything: the script ends in OP_TRUE.

P_FIELD = 2**256 - 2**32 - 977
N_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P_FIELD == 0:
        return None
    if a == b:
        m = 3 * a[0] * a[0] * pow(2 * a[1], -1, P_FIELD)
    else:
        m = (b[1] - a[1]) * pow(b[0] - a[0], -1, P_FIELD)
    x = (m * m - a[0] - b[0]) % P_FIELD
    return x, (m * (a[0] - x) - a[1]) % P_FIELD


def point_mul(k):
    out, add = None, G
    while k:
        if k & 1:
            out = point_add(out, add)
        add, k = point_add(add, add), k >> 1
    return out


def tagged(name, data):
    t = sha256(name.encode())
    return sha256(t + t + data)


def push(data):
    if len(data) <= 75:
        return bytes([len(data)]) + data
    return b"\x4c" + bytes([len(data)]) + data if len(data) <= 255 else b"\x4d" + struct.pack("<H", len(data)) + data


def inscription_output(content_type, body):
    """A P2TR output whose one leaf is an ordinals envelope then OP_TRUE; registers its unlock."""
    leaf = b"\x00\x63" + push(b"ord") + push(b"\x01") + push(content_type) + b"\x00" + push(body) + b"\x68" + OP_TRUE
    internal = G[0].to_bytes(32, "big")
    tweak = tagged("TapTweak", internal + tagged("TapLeaf", b"\xc0" + varint(len(leaf)) + leaf))
    q = point_mul((1 + int.from_bytes(tweak, "big")) % N_ORDER)
    spk = b"\x51\x20" + q[0].to_bytes(32, "big")
    UNLOCK[spk] = (b"", [leaf, bytes([0xC0 | (q[1] & 1)]) + internal])
    return spk


def submit_tagged_block(tag_bytes, short_by=0, extranonce=0):
    """Mines an empty block by hand whose coinbase carries tag_bytes after the height, then a push
    of extranonce zero bytes if any, and claims short_by sats less than the subsidy. Returns
    (block hash, coinbase txid)."""
    prev = rpc("getbestblockhash")
    head = rpc("getblockheader", prev)
    height = head["height"] + 1
    bip34 = height.to_bytes((height.bit_length() + 8) // 8, "little")
    if len(tag_bytes) > 75 or not 0 <= extranonce <= 75:
        sys.exit("regtest: a push here holds at most 75 bytes")
    script_sig = bytes([len(bip34)]) + bip34 + bytes([len(tag_bytes)]) + tag_bytes
    if extranonce:
        script_sig += bytes([extranonce]) + bytes(extranonce)
    if len(script_sig) > 100:
        sys.exit("regtest: a coinbase script holds at most 100 bytes")
    reward = (50 * 100_000_000 >> (height // 150)) - short_by  # regtest halves every 150 blocks
    coinbase = (struct.pack("<i", 2) + b"\x01" + b"\x00" * 32 + b"\xff\xff\xff\xff" + varint(len(script_sig))
                + script_sig + b"\xff\xff\xff\xff" + b"\x01" + struct.pack("<q", reward) + varint(len(MINER))
                + MINER + b"\x00\x00\x00\x00")
    txid = sha256(sha256(coinbase))  # one transaction: it is the merkle root
    bits = int(head["bits"], 16)
    target = (bits & 0xFFFFFF) << (8 * ((bits >> 24) - 3))
    when = max(int(time.time()), head["mediantime"] + 1)
    for nonce in range(1 << 32):
        header = (struct.pack("<i", 0x20000000) + bytes.fromhex(prev)[::-1] + txid
                  + struct.pack("<III", when, bits, nonce))
        block_hash = sha256(sha256(header))[::-1]
        if int.from_bytes(block_hash, "big") <= target:
            break
    result = rpc("submitblock", (header + b"\x01" + coinbase).hex())
    if result is not None:
        sys.exit(f"regtest: submitblock refused the tagged block: {result}")
    return block_hash.hex(), txid[::-1].hex()


def hostile():
    """A mined transaction with hostile OP_RETURN text and a payment to the P2WPKH address, a mined
    reveal of hostile inscriptions (one per input), then a block whose coinbase tag is markup with a
    right-to-left override and claims less than it may."""
    coin, commit_coin = take_coins(2)
    outs = [(b"\x6a" + bytes([len(n)]) + n, 0) for n in HOSTILE_NOTES] + [(P2WPKH, 10_000)]
    txid = broadcast([coin], outs, 2)
    spks = [inscription_output(t, b) for t, b in HOSTILE_INSCRIPTIONS]
    commit = broadcast([commit_coin], [(spk, 10_000) for spk in spks], 2)
    reveal = broadcast([(commit, i, spk, 10_000) for i, spk in enumerate(spks)], [(P2WPKH, 20_000)], 2)
    mine(1)
    block, coinbase = submit_tagged_block(HOSTILE_TAG, 1_000)
    return {"tx": txid, "reveal": reveal, "block": block, "coinbase": coinbase}


def tagged_blocks(texts, extranonce):
    """One hand-built empty block per text, its coinbase tagged with it."""
    made = []
    for text in texts:
        block, coinbase = submit_tagged_block(text.encode(), extranonce=extranonce)
        made.append({"block": block, "coinbase": coinbase})
    return made


def rbf(gap=0.0):
    [coin] = take_coins()
    outs = [(P2TR, 25_000_000)]
    original = broadcast([coin], outs, 1)
    # A pause lets a watcher see the original in the mempool before it is replaced.
    time.sleep(gap)
    replacement = broadcast([coin], outs, 5)
    return {"rbf_original": original, "rbf_replacement": replacement}


def cpfp():
    [coin] = take_coins()
    parent = broadcast([coin], [(MINER, 100_000_000)], 1)
    child = broadcast([(parent, 0, MINER, 100_000_000)], [(P2WPKH, 99_000_000)], 25)
    return {"cpfp_parent": parent, "cpfp_child": child}


# --- commands ---------------------------------------------------------------


def print_env(file=sys.stdout):
    print(
        f"REGTEST_RPC_HOST=127.0.0.1\nREGTEST_RPC_PORT={port('rpc')}\n"
        f"REGTEST_RPC_USER={USER}\nREGTEST_RPC_PASSWORD={PASSWORD}\n"
        f"REGTEST_ESPLORA_URL=http://127.0.0.1:{port('esplora')}\n"
        f"REGTEST_ELECTRUM_ADDR=127.0.0.1:{port('electrum')}",
        file=file,
    )


def cmd_up(_, env_to=sys.stdout):
    start = time.monotonic()
    compose("up", "-d", "--quiet-pull")
    wait_ready()
    print(f"regtest: {project()} ready in {time.monotonic() - start:.1f} s", file=sys.stderr)
    print_env(env_to)


def cmd_reset(args, env_to=sys.stdout):
    compose("down", "-v", "--remove-orphans")
    cmd_up(args, env_to)


def cmd_send(args):
    info = rpc("validateaddress", args.address)
    if not info.get("isvalid"):
        sys.exit(f"regtest: not a regtest address: {args.address}")
    spk = bytes.fromhex(info["scriptPubKey"])
    print(broadcast(take_coins(), [(spk, args.sats)], args.feerate))


def cmd_scenario(args):
    cmd_reset(args, env_to=sys.stderr)  # stdout carries only the manifest
    blocks = mine_at_fixed_times(105)  # coinbases 1..6 are now mature
    cb1, cb2, cb3 = take_coins(3)
    kinds = [(P2PKH, 100_000_000), (P2SH_TRUE, 50_000_000), (P2WPKH, 100_000_000), (P2WSH, 100_000_000),
             (P2TR, 100_000_000), (P2A, 10_000), (OP_RETURN, 0)]
    txs = {"script_types": broadcast([cb1], kinds, 2)}
    txs["consolidation"] = broadcast([cb2, cb3], [(P2WPKH, 9_000_000_000)], 3)
    blocks += mine_at_fixed_times(1)  # 106
    st = txs["script_types"]
    txs["spend_p2sh_p2a"] = broadcast([(st, 1, P2SH_TRUE, 50_000_000), (st, 5, P2A, 10_000)], [(P2TR, 49_000_000)], 4)
    blocks += mine_at_fixed_times(4)  # 107..110

    # Back to the wall clock: mempool expiry counts from acceptance time.
    rpc("setmocktime", 0)
    txs["payment"] = broadcast(take_coins(), [(P2WPKH, 50_000_000)], 2)
    txs.update(rbf())
    txs.update(cpfp())

    # Check what the scenario promises, including the address index.
    pool = set(rpc("getrawmempool"))
    want = {txs[k] for k in ("payment", "rbf_replacement", "cpfp_parent", "cpfp_child")}
    assert pool == want, f"mempool {sorted(pool)} != {sorted(want)}"
    addr = esplora(f"/tx/{st}")["vout"][2]["scriptpubkey_address"]  # the P2WPKH output
    history = {t["txid"] for t in esplora(f"/address/{addr}/txs")}
    assert {st, txs["consolidation"], txs["payment"], txs["cpfp_child"]} <= history, history
    scripthash = sha256(P2WPKH)[::-1].hex()
    assert st in {h["tx_hash"] for h in electrum("blockchain.scripthash.get_history", scripthash)}

    vout = esplora(f"/tx/{st}")["vout"]
    names = ["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr", "p2a", None, "miner"]
    addresses = {name: out["scriptpubkey_address"] for name, out in zip(names, vout) if name}
    print(json.dumps({"tip": {"height": len(blocks), "hash": blocks[-1]}, "blocks": {"1": blocks[0], "106": blocks[105]},
                      "txs": txs, "addresses": addresses}, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("up", help="start (or keep) the node, wait until ready, print env").set_defaults(f=cmd_up)
    sub.add_parser("stop", help="stop the node, keep the chain").set_defaults(f=lambda _: compose("stop"))
    sub.add_parser("down", help="remove the node and its chain").set_defaults(
        f=lambda _: compose("down", "-v", "--remove-orphans"))
    sub.add_parser("reset", help="down, then up on an empty chain").set_defaults(f=cmd_reset)
    sub.add_parser("env", help="print .env lines for the running node").set_defaults(f=lambda _: print_env())
    m = sub.add_parser("mine", help="mine N blocks to the anyone-can-spend miner script")
    m.add_argument("n", type=int)
    m.set_defaults(f=lambda a: print("\n".join(mine(a.n))))
    s = sub.add_parser("send", help="pay SATS to ADDRESS from a mature coinbase, print txid")
    s.add_argument("address")
    s.add_argument("sats", type=int)
    s.add_argument("--feerate", type=float, default=2.0, help="sat/vB (default 2)")
    s.set_defaults(f=cmd_send)
    r = sub.add_parser("rbf", help="broadcast a tx and its replacement, print both txids")
    r.add_argument("--gap", type=float, default=0.0, help="seconds between the two (default 0)")
    r.set_defaults(f=lambda a: print(json.dumps(rbf(a.gap), indent=2)))
    sub.add_parser("cpfp", help="broadcast a low-fee parent and a high-fee child").set_defaults(
        f=lambda _: print(json.dumps(cpfp(), indent=2)))
    sub.add_parser("scenario", help="reset, build the known chain, print its manifest").set_defaults(f=cmd_scenario)
    sub.add_parser("hostile", help="mine hostile OP_RETURN text, inscriptions and a coinbase tag").set_defaults(
        f=lambda _: print(json.dumps(hostile(), indent=2)))
    t = sub.add_parser("tagged", help="submit an empty block per TEXT, its coinbase tagged with it")
    t.add_argument("text", nargs="+")
    t.add_argument("--extranonce", type=int, default=0, metavar="N",
                   help="push N zero bytes after the tag; 20 is Stratum V2's layout (default: no push)")
    t.set_defaults(f=lambda a: print(json.dumps(tagged_blocks(a.text, a.extranonce), indent=2)))
    args = p.parse_args()
    try:
        args.f(args)
    except RpcError as e:
        sys.exit(f"regtest: rpc {e}")


if __name__ == "__main__":
    main()
