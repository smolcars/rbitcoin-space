#!/usr/bin/env python3
"""Checks every model under dev/models (docs/CI.md "Models"). Run: python3 -I dev/models/check.py

Each folder's model.json names a TLA+ spec, the rules that must hold on today's design, the past
mistakes that must each break a named rule, and the code the spec describes. A rule that holds
when it should break, or code that changed since the spec was last read against it, fails the run.
`--pin` records the code as read, after you have compared it with the spec; it records nothing for
a model whose rules do not check out.
"""

import functools
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TLC_VERSION = "1.7.4"
TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
TLC_URL = f"https://github.com/tlaplus/tlaplus/releases/download/v{TLC_VERSION}/tla2tools.jar"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


@functools.cache
def tlc_jar() -> Path:
    """The checker, downloaded once and held to its pinned checksum."""
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "rbitcoin-space"
    jar = cache / f"tla2tools-{TLC_VERSION}.jar"
    if not jar.exists():
        cache.mkdir(parents=True, exist_ok=True)
        part = jar.with_suffix(".part")
        with urllib.request.urlopen(TLC_URL, timeout=60) as got, open(part, "wb") as out:
            shutil.copyfileobj(got, out)
        part.replace(jar)
    if hashlib.sha256(jar.read_bytes()).hexdigest() != TLC_SHA256:
        jar.unlink()
        sys.exit(f"{TLC_URL} is not the file pinned in dev/models/check.py: removed, run again")
    return jar


@functools.cache
def java() -> str:
    home = os.environ.get("JAVA_HOME")
    found = shutil.which("java", path=f"{home}/bin" if home else None) or shutil.which("java")
    if not found:
        sys.exit("The model checker needs Java 11 or later: install one, or set JAVA_HOME")
    return found


def broken_rule(folder: Path, model: dict, constants: dict) -> str | None:
    """Runs TLC with `constants`; the rule it found broken, or None when every rule holds."""
    with tempfile.TemporaryDirectory() as tmp:
        return tlc(folder, model, constants, Path(tmp))


def tlc(folder: Path, model: dict, constants: dict, tmp: Path) -> str | None:
    cfg = tmp / "run.cfg"
    lines = [f"    {k} = {v}" for k, v in {**model["constants"], **constants}.items()]
    cfg.write_text(
        "CONSTANTS\n" + "\n".join(lines) + "\nSPECIFICATION Spec\n"
        "INVARIANTS " + " ".join(model["rules"]) + "\n"
    )
    run = subprocess.run(
        # A temp folder of its own: TLC unpacks its standard modules there, and checks that run
        # side by side would overwrite each other's.
        [java(), "-XX:+UseParallelGC", f"-Djava.io.tmpdir={tmp}", "-cp", str(tlc_jar())]
        + ["tlc2.TLC", "-workers", "1"]
        + ["-metadir", str(tmp / "states"), "-config", str(cfg), model["spec"]],
        cwd=folder,
        capture_output=True,
        text=True,
        check=False,
    )
    broke = re.search(r"Invariant (\w+) is violated", run.stdout)
    if broke:
        return broke.group(1)
    if "Model checking completed. No error has been found." not in run.stdout:
        sys.exit(f"{folder.name}: TLC did not finish:\n{run.stdout}{run.stderr}")
    return None


def region(cover: dict) -> str:
    """The lines of `file` from the one matching `from` up to the next one matching `to`."""
    lines = (REPO / cover["file"]).read_text().splitlines(keepends=True)
    start = next((i for i, l in enumerate(lines) if re.search(cover["from"], l)), None)
    if start is None:
        sys.exit(f"{cover['file']}: no line matches {cover['from']!r} (model.json \"covers\")")
    end = next((i for i in range(start + 1, len(lines)) if re.search(cover["to"], lines[i])), None)
    if end is None:
        sys.exit(f"{cover['file']}: no line matches {cover['to']!r} after {cover['from']!r}")
    return "".join(lines[start:end])


def check(folder: Path, pin: bool) -> list[str]:
    path = folder / "model.json"
    model = json.loads(path.read_text())
    faults = []
    # One checker per processor: each run is a JVM of its own, and a job's time is the sum otherwise.
    runs = model["today"] + [m["constants"] for m in model["mistakes"]]
    with ThreadPoolExecutor(os.cpu_count()) as pool:
        broke = list(pool.map(lambda constants: broken_rule(folder, model, constants), runs))
    for today, rule in zip(model["today"], broke):
        if rule:
            faults.append(f"{model['spec']}: today's design breaks {rule} with {today}")
    for mistake, rule in zip(model["mistakes"], broke[len(model["today"]) :]):
        if rule != mistake["breaks"]:
            faults.append(
                f"{model['spec']}: the mistake \"{mistake['was']}\" must break "
                f"{mistake['breaks']} and broke {rule or 'nothing'}: the model no longer "
                f"catches it"
            )
    for cover in model["covers"]:
        now = hashlib.sha256(region(cover).encode()).hexdigest()
        if pin and not faults:
            cover["sha256"] = now
        elif now != cover["sha256"]:
            faults.append(
                f"{cover['file']} changed in the part {model['spec']} describes "
                f"(from {cover['from']!r}). Read dev/models/{folder.name}/README.md, compare "
                f"each step with the code, change the spec if what happens under a lock or in "
                f"what order changed, then record it: python3 -I dev/models/check.py --pin"
            )
    if pin and not faults:
        path.write_text(json.dumps(model, indent=2) + "\n")
    return [f"dev/models/{folder.name}: {f}" for f in faults]


def main() -> None:
    pin = sys.argv[1:] == ["--pin"]
    if sys.argv[1:] and not pin:
        sys.exit(__doc__)
    folders = sorted(p.parent for p in HERE.glob("*/model.json"))
    # Once, before the checks run side by side and would each download it.
    tlc_jar(), java()
    faults = [f for folder in folders for f in check(folder, pin)]
    for fault in faults:
        print(f"::error::{fault}" if os.environ.get("GITHUB_ACTIONS") else fault, file=sys.stderr)
    if faults:
        sys.exit(1)
    print(f"{len(folders)} model(s): every rule holds on today's design and breaks on each mistake")


if __name__ == "__main__":
    main()
