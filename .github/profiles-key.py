#!/usr/bin/env python3
"""Prints `hash=` and a key for Cargo.toml's [profile] tables as cargo reads them (docs/CI.md rule 4).

rust-cache's own key leaves the profiles out, so a changed profile would keep hitting the old
cache. Parsed, not read as text: a comment or a reordering is the same profile and the same key.
The step appends this to its outputs itself, so a manifest that cannot be read fails the step.
"""

import hashlib
import json
import tomllib
from pathlib import Path

text = (Path(__file__).resolve().parent.parent / "Cargo.toml").read_text()
try:
    profiles = json.dumps(tomllib.loads(text).get("profile", {}), sort_keys=True)
except tomllib.TOMLDecodeError:
    # Cargo reads newer TOML than this Python does. Then the whole manifest is the key: it
    # changes more often than it must, and never stays the same across a changed profile.
    profiles = text
print("hash=" + hashlib.sha256(profiles.encode()).hexdigest()[:16])
