"""Tests for check.py. Run: python3 -I dev/doc-pointers/test_check.py"""

import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location(
    "check", os.path.join(os.path.dirname(os.path.abspath(__file__)), "check.py")
)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

DOCS = {
    "docs/STORE.md": "# Store\n\n## Tables\n\n### `ln_fees` and ln_watched\n\n"
    "**Versions.** Text.\n\n## Idea: sediment\n\n## Rules\n\n## Rules\n\n"
    "```\n## Not a heading\n```\n",
    "web/docs/limits.md": "# Limits\n\n## Retrying\n\n## Retrying\n",
    "README.md": "",
}


def run(files):
    files = {**DOCS, **files}
    return check.check(check.Repo(files, files.get))


class Links(unittest.TestCase):
    def test_live_links_pass(self):
        md = (
            "[a](STORE.md#ln_fees-and-ln_watched) [b](STORE.md#rules-1) [c](../README.md)"
            " [d](https://x.org/#nope) [e](#tables)\n`[f](gone.md)`\n```\n[g](gone.md)\n```\n"
        )
        self.assertEqual(run({"docs/STORE.md": DOCS["docs/STORE.md"] + md}), [])

    def test_names_the_dead_target_and_the_nearest(self):
        md = "Intro.\n[a](STORE.md#ln-fees) and [b](MOVED.md)\n"
        self.assertEqual(
            run({"docs/A.md": md}),
            [
                "docs/A.md:2: STORE.md#ln-fees does not exist; "
                "nearest: docs/STORE.md#ln_fees-and-ln_watched",
                "docs/A.md:2: MOVED.md does not exist; nearest: docs/STORE.md",
            ],
        )

    def test_public_docs_use_the_sites_anchors(self):
        page = "# Page\n\n[a](/docs/limits#retrying-2) [b](/docs/limits.md#limits) [c](/llms.txt)\n"
        self.assertEqual(
            run({"web/docs/page.md": page}),
            ["web/docs/page.md:3: /docs/limits.md#limits does not exist; "
             "nearest: web/docs/limits.md#retrying"],
        )

    def test_an_example_in_a_fence_is_not_a_pointer(self):
        md = "````md\n```\n[a](gone.md) docs/GONE.md\n```\nstill docs/GONE.md\n````\n```text\ndocs/GONE.md\n```\n"
        self.assertEqual(run({"docs/A.md": md}), [])

    def test_anchors_as_github_writes_them(self):
        target = "# T\n\n## Caf\u00e9\n\n## Rules\n\n## Rules-1\n\n## Rules\n"
        md = "[a](B.md#caf%C3%A9) [b](B.md#rules) [c](B.md#rules-1) [d](B.md#rules-2) [e](B.md#rules-3)\n"
        self.assertEqual(
            run({"docs/A.md": md, "docs/B.md": target}),
            ["docs/A.md:1: B.md#rules-3 does not exist; nearest: docs/B.md#rules"],
        )

    def test_a_fence_with_words_or_a_code_span_does_not_close_one(self):
        md = "```md\n```sh\n[a](gone.md)\n```\n\n```code``` is a span, and [b](gone.md) is read.\n"
        self.assertEqual(
            run({"docs/A.md": md}),
            ["docs/A.md:6: gone.md does not exist; nearest: docs/A.md"],
        )

    def test_a_heading_keeps_what_its_code_spans_say(self):
        target = "# T\n\n## `GET /api/v1/<id>`\n\n## `_foo_` and `__bar__`\n"
        md = "[a](B.md#get-apiv1id)\n"
        code = '// See docs/B.md "`_foo_` and `__bar__`".\n'
        self.assertEqual(run({"docs/A.md": md, "docs/B.md": target, "src/a.rs": code}), [])

    def test_a_fence_in_a_quote_and_an_encoded_anchor_after_a_doc_path(self):
        target = "# T\n\n## Caf\u00e9\n"
        md = "> ```\n> [a](gone.md) docs/GONE.md\n> ```\n\n[b](docs/B.md#caf%C3%A9)\n"
        self.assertEqual(run({"README.md": md, "docs/B.md": target}), [])

    def test_the_site_numbers_repeats_without_looking_for_a_free_one(self):
        page = "# Page\n\n## Rules\n\n## Rules-2\n\n## Rules\n\n[a](#rules-2) [b](#rules-3)\n"
        self.assertEqual(
            run({"web/docs/page.md": page}),
            ["web/docs/page.md:9: #rules-3 does not exist; nearest: web/docs/page.md#rules"],
        )

    def test_the_task_list_is_not_read(self):
        self.assertEqual(run({"docs/TODO.md": "[a](GONE.md)\n"}), [])


class Citations(unittest.TestCase):
    def test_a_name_does_not_run_on_into_code(self):
        code = '// Routes follow docs/STORE.md\n("GET /api/blocks", 200),\n'
        self.assertEqual(run({"src/a.rs": code}), [])

    def test_live_citations_pass(self):
        code = (
            '// (docs/STORE.md "Tables"), docs/STORE.md, "Versions" and "Idea"\n'
            "// docs/STORE.md#rules-1; `docs/STORE.md`, \"Rules\"; /docs/limits.md\n"
            '// docs/STORE.md ("`ln_fees` and\n// ln_watched")\n'
        )
        self.assertEqual(run({"src/a.rs": code}), [])

    def test_names_the_dead_section_and_the_nearest(self):
        code = '# docs/STORE.md "Tables", "Tabels"\n# docs/STORE.md#idea\n# docs/GONE.md\n'
        self.assertEqual(
            run({"x.sh": code}),
            [
                'x.sh:1: docs/STORE.md "Tabels" does not exist; nearest: docs/STORE.md "Tables"',
                "x.sh:2: docs/STORE.md#idea does not exist; nearest: docs/STORE.md#idea-sediment",
                "x.sh:3: docs/GONE.md does not exist; nearest: docs/STORE.md",
            ],
        )


if __name__ == "__main__":
    unittest.main()
