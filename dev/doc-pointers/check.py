#!/usr/bin/env python3
"""Fails on a link or a doc citation whose file, heading or section does not exist, naming each
with the nearest target that does (docs/CI.md "Doc pointers"). Exits 1 when it finds any.

Run from anywhere in the repository: python3 -I dev/doc-pointers/check.py
"""

import difflib
import os
import re
import subprocess
import sys
from urllib.parse import unquote

# Sources not read: the task list, which no pull request edits (AGENTS.md); shipped migrations,
# frozen byte for byte by CHECKSUMS (docs/STORE.md "Adding a migration"); and this check's tests,
# whose dead pointers are on purpose.
SKIP = re.compile(r"^(docs/TODO\.md|crates/engine/src/store/migrations/.*|dev/doc-pointers/test_)")
PUBLIC_DOCS = "web/docs/"

# A fence opens a block; one of backticks has no backtick after it, or it is a code span.
FENCE = re.compile(r"^ {0,3}(`{3,}(?!.*`)|~{3,})(.*)$")
ATX = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$")
SETEXT = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
CODE_SPAN = re.compile(r"(`+)(.+?)\1")
LINK = re.compile(r"!?\[((?:`[^`]*`|[^\]])*)\]\(<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\)")

# A repository doc: docs/<NAME>.md or docs/compat/<name>.md, at a word's start or after ../. The
# lower-case rest are rbitcoin's own docs or this site's URLs, such as /docs/limits.md.
CITED = re.compile(r"(?:(?<![\w/.-])|(?<=\.\./))(docs/(?:[A-Z][A-Z0-9_]*|compat/[\w-]+)\.md)")
QUOTE = r'\\?"([^"\\\n]+)\\?"'
# What may follow the path: an anchor, or one or more quoted section names.
AFTER = re.compile(
    r"`?(?:#((?:[\w-]|%[0-9A-Fa-f]{2})+)|,?[ ]\(?(" + QUOTE + r"(?:(?:,[ ]| and | or )" + QUOTE + r")*))"
)
# A paragraph or list item that opens in bold names a section too: "**Versions.** Two ...".
BOLD_LEAD = re.compile(r"^\s*(?:[-*+] |\d+\. )?\*\*(.+?)\*\*")
# A comment's leader, dropped when a quoted name runs on to the next line.
LEADER = re.compile(r"^\s*(//[/!]?|#|\*|--|<!--)?\s*")


def github_slug(text):
    """GitHub's anchor for a heading's rendered text: lower case, no punctuation, spaces hyphens."""
    return re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")


def site_slug(text):
    """web/src/docs/markdown.ts slug(): lower-case words joined by single hyphens."""
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", text.lower())) or "section"


def github_text(src):
    """A heading's text as GitHub renders it: code spans' contents, links' words, no markup."""
    src = re.sub(r"!?\[((?:`[^`]*`|[^\]])*)\]\([^)]*\)", r"\1", src)

    def plain(text):
        return re.sub(r"&\w+;", "", unemphasise(re.sub(r"<[^>]+>", "", text)))

    # A code span's text is kept as written: `<id>` and `a_b` in one are not markup.
    out, last = [], 0
    for m in CODE_SPAN.finditer(src):
        out.append(plain(src[last : m.start()]))
        out.append(m.group(2).strip())
        last = m.end()
    out.append(plain(src[last:]))
    return "".join(out)


def unemphasise(src):
    """Drops emphasis marks and backslash escapes; an underscore inside a word is not emphasis."""
    return re.sub(r"\\(.)|\*|(?<!\w)_+|_+(?!\w)", r"\1", src)


def site_text(src):
    """web/src/docs/markdown.ts plain()."""
    src = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", src)
    return re.sub(r"\*\*|`", "", src).replace("\\|", "|")


def outside_code(lines):
    """Yields (line number, line) for the lines outside fenced code blocks."""
    fence = None
    for n, line in enumerate(lines, 1):
        # A fence inside a quote is a fence.
        m = FENCE.match(re.sub(r"^ {0,3}(?:> ?)+", "", line))
        if m:
            if fence is None:
                fence = m.group(1)
            # A longer block holds shorter fences as text, and so is a fence with words after it:
            # only a bare one as long closes it.
            elif m.group(1).startswith(fence) and not m.group(2).strip():
                fence = None
            continue
        if fence is None:
            yield n, line


class Doc:
    """A Markdown file's headings, with the anchors each renderer gives them."""

    def __init__(self, text):
        self.headings = []  # (depth, raw text)
        names = []
        prev = ""
        for _, line in outside_code(text.split("\n")):
            bold = BOLD_LEAD.match(line)
            if bold:
                names.append(github_text(bold.group(1).rstrip(".:")))
            atx = ATX.match(line)
            if atx:
                self.headings.append((len(atx.group(1)), atx.group(2)))
            elif SETEXT.match(line) and prev.strip() and not re.match(r"\s*([-*+|>#]|\d+\.)", prev):
                self.headings.append((1 if "=" in line else 2, prev.strip()))
            prev = line
        self.github = anchors([github_slug(github_text(t)) for _, t in self.headings], 0)
        # The site gives the page's title no anchor and reads headings down to ####.
        site = [(d, t) for d, t in self.headings if d <= 4]
        if site and site[0][0] == 1:
            site = site[1:]
        self.site = anchors([site_slug(site_text(t)) for _, t in site], 1)
        # A heading is also cited by its words before a colon or a bracket: "Idea" for
        # "Idea: sediment, quietly", "Ark" for "Ark (not in the prototype)".
        self.sections = [github_text(t) for _, t in self.headings]
        for t in self.sections:
            names += [t, re.split(r":| \(", t)[0]]
        self.names = {github_slug(n): n for n in names}


def anchors(bases, first):
    """Numbers repeats as their renderer does: GitHub's second "a" is a-1, the site's a-2."""
    seen, out = {}, []
    for b in bases:
        n = seen.get(b, first - 1) + 1
        slug = b if n == first else f"{b}-{n}"
        # On GitHub a heading that is itself "a-1" has taken that anchor. The site gives it twice.
        while first == 0 and slug in out:
            n += 1
            slug = f"{b}-{n}"
        seen[b] = n
        out.append(slug)
    return out


class Repo:
    """The files a check reads: their paths, and read(path) giving the text or None if binary."""

    def __init__(self, files, read):
        self.files = sorted(files)
        self.read = read
        self.paths = set(self.files) | {"."}
        for f in self.files:
            while f := os.path.dirname(f):
                self.paths.add(f)
        self._docs = {}

    @classmethod
    def from_git(cls):
        """Every file git tracks or would track, so a new file is checked before its commit."""
        git = ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
        root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, check=True, text=True
        ).stdout.strip()
        out = subprocess.run(git, cwd=root, capture_output=True, check=True).stdout.decode()

        def read(path):
            try:
                with open(os.path.join(root, path), encoding="utf-8") as f:
                    return f.read()
            except (UnicodeDecodeError, OSError):
                return None

        return cls([f for f in out.split("\0") if f], read)

    def doc(self, path):
        if path not in self._docs:
            self._docs[path] = Doc(self.read(path) or "")
        return self._docs[path]

    def exists(self, path):
        return path in self.paths


def nearest(word, choices):
    """The choice that starts with word or that word starts with, then one that holds it, then the
    one sharing the longest start, then the most alike: a renamed heading keeps some words."""

    def score(c):
        start = len(os.path.commonprefix([word, c]))
        prefix = start == min(len(word), len(c))
        return prefix, word in c, start, difflib.SequenceMatcher(None, word, c).ratio()

    return max(choices, key=score, default="none")


def nearest_file(repo, path):
    return nearest(path, [f for f in repo.files if f.endswith(".md") == path.endswith(".md")])


def public_page(path):
    """/docs/api/fees(.md) to web/docs/api/fees.md, as web/src/docs/pages.ts maps a page's slug."""
    page = path.removeprefix("/docs").strip("/").removesuffix(".md") or "index"
    return PUBLIC_DOCS + page + ".md"


def check_links(repo, path, text, report):
    public = path.startswith(PUBLIC_DOCS)
    for n, line in outside_code(text.split("\n")):
        for m in LINK.finditer(CODE_SPAN.sub(lambda s: " " * len(s.group(0)), line)):
            href = m.group(2)
            if re.match(r"^[a-z][a-z0-9+.-]*:|^//", href, re.I):
                continue
            target, _, anchor = href.partition("#")
            anchor = unquote(anchor)
            if target.startswith("/"):
                if not (public and (target == "/docs" or target.startswith("/docs/"))):
                    continue
                file, rule = public_page(target), "site"
            elif target:
                file = os.path.normpath(os.path.join(os.path.dirname(path), target))
                rule = "github"
            else:
                file, rule = path, "site" if public else "github"
            if not repo.exists(file):
                report(path, n, href, nearest_file(repo, file))
            elif anchor and file.endswith(".md"):
                anchors = getattr(repo.doc(file), rule)
                if anchor not in anchors:
                    report(path, n, href, f"{file}#{nearest(anchor, anchors)}")


def check_citations(repo, path, text, report):
    lines = text.split("\n")
    read = outside_code(lines) if path.endswith(".md") else enumerate(lines, 1)
    for i, line in ((n - 1, line) for n, line in read):
        for m in CITED.finditer(line):
            doc = m.group(1)
            if not repo.exists(doc):
                report(path, i + 1, doc, nearest_file(repo, doc))
                continue
            # A name may run on to the next lines of the same comment, never into code.
            more = []
            for n in lines[i + 1 : i + 3]:
                if not path.endswith(".md") and not LEADER.match(n).group(1):
                    break
                more.append(" " + LEADER.sub("", n))
            rest = line[m.end() :] + "".join(more)
            after = AFTER.match(rest)
            if not after:
                continue
            d = repo.doc(doc)
            if after.group(1):
                anchor = unquote(after.group(1))
                if anchor not in d.github:
                    report(path, i + 1, f"{doc}#{anchor}", f"{doc}#{nearest(anchor, d.github)}")
                continue
            for name in re.findall(QUOTE, after.group(2)):
                if github_slug(github_text(name)) not in d.names:
                    best = nearest(github_slug(name), [github_slug(t) for t in d.sections])
                    report(path, i + 1, f'{doc} "{name}"', f'{doc} "{d.names.get(best, best)}"')


def check(repo):
    """Every dead pointer in the repository, as "file:line: target ...; nearest: ..."."""
    found = {}  # a dict, to report once a doc both linked and named on one line

    def report(path, line, target, near):
        found[f"{path}:{line}: {target} does not exist; nearest: {near}"] = None

    for path in repo.files:
        text = None if SKIP.match(path) else repo.read(path)
        if text is None:
            continue
        if path.endswith(".md"):
            check_links(repo, path, text, report)
        check_citations(repo, path, text, report)
    return list(found)


def main():
    found = check(Repo.from_git())
    for f in found:
        print(f)
    if found:
        print(f"{len(found)} dead pointers: repoint each where its fact lives.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
