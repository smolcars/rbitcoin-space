#!/usr/bin/env python3
"""Prints a key for Cargo.toml's [profile] tables as cargo reads them (docs/CI.md rule 4).

rust-cache's own key leaves the profiles out, so a changed profile would keep hitting the old
cache. Parsed, not read as text: a comment or a reordering is the same profile and the same key.
"""

import hashlib
import json
import tomllib
from pathlib import Path

manifest = tomllib.loads((Path(__file__).resolve().parent.parent / "Cargo.toml").read_text())
profiles = json.dumps(manifest.get("profile", {}), sort_keys=True)
print(hashlib.sha256(profiles.encode()).hexdigest()[:16])
