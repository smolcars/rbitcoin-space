#!/usr/bin/env python3
"""Fails when the image's build would miss what the workspace needs (docs/CI.md "Jobs", `image`).

The Rust stage is built only after merge, so these are checked before it: every workspace member
reaches the build, and the image's Rust and Bun are the versions the repository pins.
Run: python3 -I .github/image-inputs.py
"""

import json
import re
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def members() -> list[str]:
    """Each folder cargo reads a manifest from: the workspace's members, globs expanded, and
    every package one of them depends on by path."""
    workspace = tomllib.loads((REPO / "Cargo.toml").read_text())["workspace"]
    shared = workspace.get("dependencies", {})
    left_out = [REPO / e for e in workspace.get("exclude", [])]
    todo = [
        p.parent
        for pattern in workspace["members"]
        for p in sorted(REPO.glob(f"{pattern}/Cargo.toml"))
        if p.parent not in left_out
    ]
    # A patch by path is one more manifest cargo reads.
    root = tomllib.loads((REPO / "Cargo.toml").read_text())
    for registry in root.get("patch", {}).values():
        todo += [(REPO / d["path"]).resolve() for d in registry.values() if "path" in d]
    found: list[Path] = []
    while todo:
        folder = todo.pop(0)
        if folder in found:
            continue
        found.append(folder)
        manifest = tomllib.loads((folder / "Cargo.toml").read_text())
        tables = [manifest, *manifest.get("target", {}).values()]
        for table in tables:
            for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
                for name, dep in table.get(kind, {}).items():
                    if not isinstance(dep, dict):
                        continue
                    if "path" in dep:
                        todo.append((folder / dep["path"]).resolve())
                    elif dep.get("workspace") and "path" in shared.get(name, {}):
                        todo.append((REPO / shared[name]["path"]).resolve())
    return [f.relative_to(REPO).as_posix() for f in found]


def under(path: str, folders: list[str]) -> bool:
    return any(path == f or path.startswith(f + "/") for f in folders)


def pattern(rule: str) -> re.Pattern:
    """A .dockerignore pattern as Docker reads it: from the context's root, `**` across folders."""
    out = ""
    for part in re.split(r"(\*\*/?|\*|\?)", rule.strip("/")):
        if part == "**/":
            out += "(?:.*/)?"
        elif part == "**":
            out += ".*"
        elif part == "*":
            out += "[^/]*"
        elif part == "?":
            out += "[^/]"
        else:
            out += re.escape(part)
    return re.compile(f"{out}(/.*)?")


def ignored(path: str, rules: list[str]) -> bool:
    """Whether .dockerignore keeps `path` out of the build: the last rule that matches decides."""
    out = False
    for rule in rules:
        keep = rule.startswith("!")
        if pattern(rule.removeprefix("!")).fullmatch(path):
            out = not keep
    return out


def copies(stage: str) -> list[str]:
    """What the stage's `COPY` lines put where the build looks for it: a file into the working
    directory, or a folder to its own path."""
    found = []
    for line in re.findall(r"^COPY (.+)$", stage, re.M):
        if "--from" in line:
            continue
        *sources, to = [word for word in line.split() if not word.startswith("--")]
        for source in sources:
            here = source.removeprefix("./").rstrip("/")
            if (REPO / here).is_dir():
                if to.removeprefix("./").rstrip("/") == here:
                    found.append(here)
            elif to in (".", "./") or to.removeprefix("./") == here:
                found.append(here)
    return found


def main() -> None:
    dockerfile = (REPO / "Dockerfile").read_text()
    server = dockerfile.split(" AS server\n", 1)[1].split("\nFROM ", 1)[0]
    server = "\n".join(l for l in server.splitlines() if not l.lstrip().startswith("#"))
    server = server.replace("\\\n", " ")
    copied = copies(server)
    touched = re.search(r"find (.+?) -exec touch", server)
    touched = [t.rstrip("/") for t in touched.group(1).split()] if touched else []
    rules = [
        line.strip()
        for line in (REPO / ".dockerignore").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    faults = []
    if not touched:
        faults.append(
            "Dockerfile's server stage no longer touches its sources before `cargo build`: a "
            "cached build older than them would be kept (the image once shipped without a new "
            "migration)"
        )
    for file in ("Cargo.toml", "Cargo.lock"):
        if ignored(file, rules):
            faults.append(f".dockerignore keeps {file} out of the build: add `!{file}`")
        if file not in copied:
            faults.append(f"Dockerfile's server stage does not copy {file}: `cargo build --locked` needs it")
    for member in members():
        fix = f"cargo reads every member's manifest, so the image cannot build without {member}/"
        if ignored(f"{member}/Cargo.toml", rules):
            faults.append(
                f".dockerignore keeps {member}/ out of the build: add `!{member}/` after the rule "
                f"that leaves it out ({fix})"
            )
        if not under(member, copied):
            faults.append(
                f"Dockerfile's server stage does not copy {member}/: "
                f"add `COPY {member}/ {member}/` ({fix})"
            )
        if touched and not under(member, touched):
            faults.append(
                f"Dockerfile's `find … -exec touch` skips {member}/: add it, or a cached build "
                f"older than its sources would be kept"
            )

    rust = tomllib.loads((REPO / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    bun = json.loads((REPO / "web/package.json").read_text())["packageManager"].removeprefix("bun@")
    for name, image, pinned, owner in [
        ("RUST_IMAGE", "rust", rust, "rust-toolchain.toml"),
        ("BUN_IMAGE", "bun", bun, "web/package.json's packageManager"),
    ]:
        tag = re.search(rf"^ARG {name}=\S+/{image}:(\d+\.\d+\.\d+)", dockerfile, re.M)
        if not tag or tag.group(1) != pinned:
            faults.append(
                f"Dockerfile's {name} is {tag.group(1) if tag else 'not a version'} and {owner} "
                f"pins {pinned}: set the image's tag, and its digest, to {pinned}"
            )

    for fault in faults:
        print(f"::error::{fault}", file=sys.stderr)
    if faults:
        sys.exit(1)
    print("The image's build has every workspace member, and its Rust and Bun are the pinned ones")


if __name__ == "__main__":
    main()
