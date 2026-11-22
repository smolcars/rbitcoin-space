//! A test never passes or fails on how long something took on the machine that runs it (docs/CI.md
//! "Rules for tests"). This finds the form of that mistake the source shows: an assertion that a
//! span of real time stayed under a bound.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashMap;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

const FIX: &str = "\
These assertions put an upper bound on how long real time took, so a slow or busy machine fails \
them for no fault of the code (docs/CI.md \"Rules for tests\"). Instead:
  - wait for the event the test means (a reply, a log line, a gate the test opens) and assert what \
happened, not how soon;
  - or run the test on tokio's paused clock, #[tokio::test(start_paused = true)] or \
tokio::time::pause(), reading time only from tokio::time::Instant, where a timer's spacing is exact;
  - or, for a speed budget, give it a test of its own under #[ignore = \"a time budget: ...\"] with \
the command that runs it in its doc comment, and keep a test of the same answers, without the \
clock, in the suite.
A polling loop's ceiling is no budget, as it fails only when the event never comes: take the start \
or the deadline before a `loop`, a `while` or a `for` that can `break`, and check it inside, \
`assert!(started.elapsed() < WAIT, \"never ...\")`.";

#[test]
fn no_assertion_bounds_real_elapsed_time() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut found = Vec::new();
    for file in rust_files(&root) {
        let src = fs::read_to_string(&file).unwrap();
        let name = file.strip_prefix(&root).unwrap().display().to_string();
        found.extend(
            findings(&src)
                .into_iter()
                .map(|(line, what)| format!("{name}:{line}: {what}")),
        );
    }
    assert!(found.is_empty(), "{FIX}\n\n{}\n", found.join("\n"));
}

fn rust_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut dirs = vec![root.join("crates"), root.join("dev")];
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path
                    .file_name()
                    .is_some_and(|n| n != "target" && n != "node_modules")
                {
                    dirs.push(path);
                }
            } else if path.extension().is_some_and(|e| e == "rs") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

/// Each assertion in `src` that bounds a span of real time from above: its line and what it says.
fn findings(src: &str) -> Vec<(usize, String)> {
    let code = code_only(src);
    // Every clock read, and every name bound to one, has one of these words in it.
    if find(&code, b"elapsed").is_none() && find(&code, b"Instant").is_none() {
        return Vec::new();
    }
    let functions = functions(&code);
    let names = Names::new(&code);
    let loops = loops(&code);
    let mut found = Vec::new();
    for (at, cond) in assertions(&code) {
        let cond = &code[cond];
        let budget = comparisons(cond).into_iter().any(|(lesser, greater)| {
            match clock(lesser, greater, at, &names) {
                None => false,
                Some(Clock::Span) => true,
                Some(Clock::Since(starts) | Clock::Now(starts)) => {
                    !hang_guard(at, &starts, &loops, &names)
                }
            }
        });
        if budget && !functions.iter().any(|f| f.exempts(&code, at)) {
            let line = code[..at].iter().filter(|&&c| c == b'\n').count() + 1;
            found.push((line, squash(cond)));
        }
    }
    found
}

/// The source with comments and string and character literals turned to spaces, byte for byte, so
/// offsets and lines still match and nothing inside them reads as code.
fn code_only(src: &str) -> Vec<u8> {
    let b = src.as_bytes();
    let mut code = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        let end = match (b[i], b.get(i + 1).copied()) {
            (b'/', Some(b'/')) => b[i..]
                .iter()
                .position(|&c| c == b'\n')
                .map_or(b.len(), |n| i + n),
            (b'/', Some(b'*')) => {
                let (mut j, mut depth) = (i + 2, 1);
                while j < b.len() && depth > 0 {
                    if b[j..].starts_with(b"/*") {
                        depth += 1;
                        j += 1;
                    } else if b[j..].starts_with(b"*/") {
                        depth -= 1;
                        j += 1;
                    }
                    j += 1;
                }
                j
            }
            (b'"', _) => {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                j + 1
            }
            (b'r', Some(b'"' | b'#')) if raw_string_may_start(b, i) => {
                let hashes = b[i + 1..].iter().take_while(|&&c| c == b'#').count();
                if b.get(i + 1 + hashes) != Some(&b'"') {
                    i += 1;
                    continue;
                }
                let close: Vec<u8> = std::iter::once(b'"')
                    .chain(std::iter::repeat_n(b'#', hashes))
                    .collect();
                let body = i + 2 + hashes;
                b[body..]
                    .windows(close.len())
                    .position(|w| w == close)
                    .map_or(b.len(), |n| body + n + close.len())
            }
            (b'\'', Some(b'\\')) => b[i + 3..]
                .iter()
                .position(|&c| c == b'\'')
                .map_or(b.len(), |n| i + 4 + n),
            (b'\'', Some(c)) => {
                let len = match c {
                    0..0x80 => 1,
                    0x80..0xe0 => 2,
                    0xe0..0xf0 => 3,
                    _ => 4,
                };
                if b.get(i + 1 + len) == Some(&b'\'') {
                    i + 2 + len
                } else {
                    // A lifetime or a label.
                    i += 1;
                    continue;
                }
            }
            _ => {
                i += 1;
                continue;
            }
        };
        let end = end.min(b.len());
        for c in &mut code[i..end] {
            if *c != b'\n' {
                *c = b' ';
            }
        }
        i = end;
    }
    code
}

fn raw_string_may_start(b: &[u8], i: usize) -> bool {
    match i.checked_sub(1).map(|p| b[p]) {
        Some(b'b' | b'c') => i < 2 || !ident(b[i - 2]),
        Some(c) => !ident(c),
        None => true,
    }
}

fn ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).rposition(|w| w == needle)
}

/// Where `word` stands on its own in `code`.
fn words<'a>(code: &'a [u8], word: &'a [u8]) -> impl Iterator<Item = usize> + 'a {
    (0..=code.len().saturating_sub(word.len())).filter(move |&i| {
        code[i..].starts_with(word)
            && (i == 0 || !ident(code[i - 1]))
            && code.get(i + word.len()).is_none_or(|&c| !ident(c))
    })
}

/// The identifiers in `code`: where each starts, the name, and what follows it.
fn idents(code: &[u8]) -> impl Iterator<Item = (usize, &[u8], &[u8])> {
    (0..code.len())
        .filter(|&i| ident(code[i]) && !code[i].is_ascii_digit() && (i == 0 || !ident(code[i - 1])))
        .map(|i| {
            let end = code[i..]
                .iter()
                .position(|&c| !ident(c))
                .map_or(code.len(), |n| i + n);
            (i, &code[i..end], &code[end..])
        })
}

fn squash(code: &[u8]) -> String {
    String::from_utf8_lossy(code)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The index just past the bracket that closes the one at `open`.
fn closing(code: &[u8], open: usize) -> usize {
    let mut depth = 0;
    for (i, &c) in code.iter().enumerate().skip(open) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
    }
    code.len()
}

/// The index of the bracket that opens the one at `close`.
fn opening(code: &[u8], close: usize) -> Option<usize> {
    let mut depth = 0;
    for i in (0..=close).rev() {
        match code[i] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// The block that follows the header starting at `at`: the first `{` outside brackets, to its match.
fn block_after(code: &[u8], at: usize) -> Option<Range<usize>> {
    let mut depth = 0;
    for (i, &c) in code.iter().enumerate().skip(at) {
        match c {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'{' if depth == 0 => return Some(i..closing(code, i)),
            b';' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

/// Each block `{ … }` in `code`, in the order they open.
fn blocks(code: &[u8]) -> Vec<Range<usize>> {
    let (mut open, mut found) = (Vec::new(), Vec::new());
    for (i, &c) in code.iter().enumerate() {
        match c {
            b'{' => {
                open.push(found.len());
                found.push(i..code.len());
            }
            b'}' => {
                if let Some(k) = open.pop() {
                    found[k].end = i + 1;
                }
            }
            _ => {}
        }
    }
    found
}

/// The innermost of `blocks` around `at`.
fn around(blocks: &[Range<usize>], at: usize) -> Range<usize> {
    blocks[..blocks.partition_point(|b| b.start < at)]
        .iter()
        .rev()
        .find(|b| b.contains(&at))
        .cloned()
        .unwrap_or(0..usize::MAX)
}

struct Function {
    body: Range<usize>,
    ignored: bool,
    start_paused: bool,
    /// The last `use` before it to name an `Instant` names `std`'s.
    std_instant: bool,
}

impl Function {
    /// Whether a bound at `at` is in an ignored test, or on tokio's paused clock at that point of a
    /// test that reads no clock tokio cannot pause.
    fn exempts(&self, code: &[u8], at: usize) -> bool {
        if !self.body.contains(&at) {
            return false;
        }
        let before = &code[self.body.start..at];
        let (pause, resume) = (
            rfind(before, b"time::pause()"),
            rfind(before, b"time::resume()"),
        );
        let paused = if pause.is_some() || resume.is_some() {
            pause > resume
        } else {
            self.start_paused
        };
        self.ignored || (paused && !self.reads_std_clock(&code[self.body.clone()]))
    }

    /// Whether `body` reads `std`'s clock, which tokio's pause leaves running.
    fn reads_std_clock(&self, body: &[u8]) -> bool {
        find(body, b"SystemTime").is_some()
            || find(body, b"std::time::Instant").is_some()
            || (self.std_instant && words(body, b"Instant").any(|i| !body[..i].ends_with(b"::")))
    }
}

fn functions(code: &[u8]) -> Vec<Function> {
    // Each `use` that names an `Instant`, and whether it is `std`'s.
    let uses: Vec<(usize, bool)> = words(code, b"use")
        .filter_map(|at| {
            let end = code[at..]
                .iter()
                .position(|&c| c == b';')
                .map_or(code.len(), |n| at + n);
            let stmt = &code[at..end];
            words(stmt, b"Instant")
                .next()
                .map(|_| (at, stmt.starts_with(b"use std")))
        })
        .collect();
    words(code, b"fn")
        .filter(|&at| code.get(at + 2).is_some_and(u8::is_ascii_whitespace))
        .filter_map(|at| {
            let body = block_after(code, at)?;
            let attributes = attributes(code, at);
            let tight: Vec<u8> = attributes
                .iter()
                .copied()
                .filter(|c| !c.is_ascii_whitespace())
                .collect();
            Some(Function {
                ignored: words(attributes, b"ignore").next().is_some(),
                start_paused: find(&tight, b"start_paused=true").is_some(),
                std_instant: uses
                    .iter()
                    .rev()
                    .find(|&&(u, _)| u < at)
                    .is_some_and(|&(_, std)| std),
                body,
            })
        })
        .collect()
}

/// The attributes and qualifiers written before the `fn` at `at`.
fn attributes(code: &[u8], at: usize) -> &[u8] {
    let mut i = at;
    loop {
        while i > 0 && code[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        match i.checked_sub(1).map(|p| code[p]) {
            Some(b']') => match opening(code, i - 1) {
                Some(open) if open > 0 && code[open - 1] == b'#' => i = open - 1,
                _ => break,
            },
            Some(b')') => match opening(code, i - 1) {
                Some(open) if code[..open].ends_with(b"pub") => i = open - 3,
                _ => break,
            },
            Some(c) if ident(c) => {
                let start = code[..i]
                    .iter()
                    .rposition(|&c| !ident(c))
                    .map_or(0, |p| p + 1);
                if [&b"pub"[..], b"async", b"const", b"unsafe", b"extern"]
                    .contains(&&code[start..i])
                {
                    i = start;
                } else {
                    break;
                }
            }
            _ => break,
        }
    }
    &code[i..at]
}

/// The bodies of the loops in `code` that can run until an event comes: each `loop` and `while`,
/// and each `for` that can leave early. One that cannot runs every pass, so a bound inside it is on
/// the work done so far.
fn loops(code: &[u8]) -> Vec<Range<usize>> {
    let leaves = |body: &Range<usize>| {
        let body = &code[body.clone()];
        words(body, b"break").next().is_some() || words(body, b"return").next().is_some()
    };
    words(code, b"loop")
        .chain(words(code, b"while"))
        .filter_map(|at| block_after(code, at))
        .chain(
            fors(code)
                .filter_map(|at| block_after(code, at))
                .filter(leaves),
        )
        .collect()
}

/// Where each `for` loop starts: not `impl Trait for Type` or `for<'a>`.
fn fors(code: &[u8]) -> impl Iterator<Item = usize> + '_ {
    words(code, b"for").filter(|&at| {
        let before = code[..at].trim_ascii_end();
        let after = code[at + 3..].trim_ascii_start();
        before.last().is_none_or(|c| b";{}:".contains(c)) && !after.starts_with(b"<")
    })
}

/// Where a name is bound.
enum Kind {
    /// By a `let`, or by the pattern of a `for`, an `if let` or a `while let`: in this block.
    Let(Range<usize>),
    /// By `name = value;`, to the name a `let` bound.
    Assign,
    /// By `name: value` in a struct, and read as `.name` anywhere in the file: a struct is often
    /// built in a helper and checked in a test.
    Field,
}

struct Binding<'a> {
    name: &'a [u8],
    at: usize,
    kind: Kind,
    /// The value, when the name takes the whole of it rather than a part of a destructured one.
    value: Option<&'a [u8]>,
    /// The value is an instant read off the clock.
    instant: bool,
    /// The value is a span measured on the clock.
    span: bool,
}

impl<'a> Binding<'a> {
    fn new(name: &'a [u8], at: usize, kind: Kind, value: Option<&'a [u8]>) -> Self {
        Binding {
            name,
            at,
            kind,
            value,
            instant: false,
            span: false,
        }
    }
}

/// The names bound in a file, each looked up as Rust sees it from a point in the code.
struct Names<'a> {
    all: Vec<Binding<'a>>,
    by_name: HashMap<&'a [u8], Vec<usize>>,
}

impl<'a> Names<'a> {
    fn new(code: &'a [u8]) -> Self {
        let all = bindings(code);
        let mut by_name: HashMap<&[u8], Vec<usize>> = HashMap::new();
        for (k, b) in all.iter().enumerate() {
            by_name.entry(b.name).or_default().push(k);
        }
        let mut names = Names { all, by_name };
        // Instants first, then the spans measured from them: one name deep, as in `at - announced`.
        let read = |names: &Names<'a>| -> Vec<Option<Clock<'a>>> {
            names
                .all
                .iter()
                .map(|b| clock(b.value?, b"", b.at, names))
                .collect()
        };
        let instants = read(&names);
        for (b, c) in names.all.iter_mut().zip(instants) {
            // `Instant::now() + WAIT` is a deadline, never subtracted to measure a span.
            b.instant =
                matches!(c, Some(Clock::Now(_))) && !b.value.is_some_and(|v| v.contains(&b'+'));
        }
        let spans = read(&names);
        for (b, c) in names.all.iter_mut().zip(spans) {
            b.span = matches!(c, Some(Clock::Span | Clock::Since(_)));
        }
        names
    }

    /// The `let` that `name` refers to at `at`, and each assignment to that `let` before `at`.
    fn visible(&self, name: &[u8], at: usize) -> Vec<&Binding<'a>> {
        let same: Vec<&Binding<'a>> = self
            .by_name
            .get(name)
            .into_iter()
            .flatten()
            .map(|&k| &self.all[k])
            .collect();
        // The declaration in scope at a place: the latest `let` of the name whose block holds it.
        let declared = |at: usize| {
            same.iter()
                .filter(|b| matches!(&b.kind, Kind::Let(scope) if b.at < at && scope.contains(&at)))
                .map(|b| b.at)
                .max()
        };
        let Some(decl) = declared(at) else {
            return Vec::new();
        };
        same.iter()
            .copied()
            .filter(|b| {
                b.at == decl
                    || (matches!(b.kind, Kind::Assign) && b.at < at && declared(b.at) == Some(decl))
            })
            .collect()
    }

    fn span(&self, name: &[u8], at: usize) -> bool {
        self.visible(name, at).iter().any(|b| b.span)
    }

    fn instant(&self, name: &[u8], at: usize) -> bool {
        self.visible(name, at).iter().any(|b| b.instant)
    }

    fn field(&self, name: &[u8]) -> bool {
        self.by_name
            .get(name)
            .into_iter()
            .flatten()
            .any(|&k| matches!(self.all[k].kind, Kind::Field) && self.all[k].span)
    }
}

/// Each name that a `let`, a loop's pattern, an assignment or a struct's field binds.
fn bindings<'a>(code: &'a [u8]) -> Vec<Binding<'a>> {
    let blocks = blocks(code);
    let mut found = Vec::new();
    let mut bind = |pattern: &'a [u8], at, scope: Range<usize>, value: Option<&'a [u8]>| {
        let pattern = &pattern[..ascription(pattern).unwrap_or(pattern.len())];
        let names: Vec<&[u8]> = pattern
            .split(|&c| !ident(c))
            .filter(|w| !w.is_empty() && *w != b"mut" && *w != b"ref")
            .collect();
        let whole =
            names.len() == 1 && pattern.iter().all(|&c| ident(c) || c.is_ascii_whitespace());
        for name in names {
            found.push(Binding::new(
                name,
                at,
                Kind::Let(scope.clone()),
                value.filter(|_| whole),
            ));
        }
    };
    for at in words(code, b"let") {
        let mut depth = 0;
        let mut eq = None;
        let mut end = code.len();
        for (i, &c) in code.iter().enumerate().skip(at) {
            match c {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' if depth == 0 => {
                    end = i;
                    break;
                }
                b')' | b']' | b'}' => depth -= 1,
                b'=' if depth == 0 && eq.is_none() && code.get(i + 1) != Some(&b'=') => {
                    eq = Some(i);
                }
                b';' if depth == 0 => {
                    end = i;
                    break;
                }
                _ => {}
            }
        }
        let Some(eq) = eq else { continue };
        let pattern = &code[at + 3..eq];
        let before = code[..at].trim_ascii_end();
        if [&b"if"[..], b"while", b"&&"]
            .iter()
            .any(|w| before.ends_with(w))
        {
            if let Some(body) = block_after(code, eq) {
                bind(pattern, at, body, None);
            }
        } else {
            bind(
                pattern,
                at,
                around(&blocks, at),
                Some(&code[eq + 1..end.max(eq + 1)]),
            );
        }
    }
    for at in fors(code) {
        let Some(body) = block_after(code, at) else {
            continue;
        };
        if let Some(i) = words(&code[at..body.start], b"in").next() {
            bind(&code[at + 3..at + i], at, body, None);
        }
    }
    // `took = started.elapsed();`, one to a line.
    let mut start = 0;
    for line in code.split(|&c| c == b'\n') {
        let at = start + line.len() - line.trim_ascii_start().len();
        start += line.len() + 1;
        let line = line.trim_ascii_start();
        let name_end = line.iter().position(|&c| !ident(c)).unwrap_or(line.len());
        if name_end > 0 && line[name_end..].starts_with(b" = ") {
            let value = Some(&line[name_end + 3..]);
            found.push(Binding::new(&line[..name_end], at, Kind::Assign, value));
        }
    }
    // `took: started.elapsed()` in a struct, after its `{` or a `,`.
    for (i, name, after) in idents(code) {
        if after.starts_with(b":")
            && !after.starts_with(b"::")
            && code[..i]
                .trim_ascii_end()
                .last()
                .is_some_and(|c| b"{,".contains(c))
        {
            let from = i + name.len() + 1;
            found.push(Binding::new(
                name,
                i,
                Kind::Field,
                Some(operand_after(code, from)),
            ));
        }
    }
    found
}

/// Where a type ascription starts in a pattern: its `:`, not a path's `::`.
fn ascription(pattern: &[u8]) -> Option<usize> {
    (0..pattern.len()).find(|&i| {
        pattern[i] == b':'
            && pattern.get(i + 1) != Some(&b':')
            && (i == 0 || pattern[i - 1] != b':')
    })
}

/// Each assertion macro's position and the span of its condition, its first argument.
fn assertions(code: &[u8]) -> Vec<(usize, Range<usize>)> {
    let mut found = Vec::new();
    for at in (0..code.len()).filter(|&i| code[i..].starts_with(b"assert!")) {
        let name = code[..at]
            .iter()
            .rposition(|&c| !ident(c))
            .map_or(0, |p| p + 1);
        let Some(open) = (at + 7..code.len()).find(|&i| !code[i].is_ascii_whitespace()) else {
            continue;
        };
        if !matches!(code[open], b'(' | b'[' | b'{') {
            continue;
        }
        let mut depth = 0;
        let mut end = code.len();
        for (i, &c) in code.iter().enumerate().skip(open + 1) {
            match c {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' if depth == 0 => {
                    end = i;
                    break;
                }
                b')' | b']' | b'}' => depth -= 1,
                b',' if depth == 0 => {
                    end = i;
                    break;
                }
                _ => {}
            }
        }
        found.push((name, open + 1..end));
    }
    found
}

/// The lesser and the greater side of each `<`, `<=`, `>` and `>=` in a condition. rustfmt spaces
/// a comparison and never a generic's brackets.
fn comparisons(cond: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut sides = Vec::new();
    let mut i = 1;
    while i < cond.len() {
        if matches!(cond[i], b'<' | b'>') && cond[i - 1].is_ascii_whitespace() {
            let end = i + 1 + usize::from(cond.get(i + 1) == Some(&b'='));
            if cond.get(end).is_some_and(u8::is_ascii_whitespace) {
                let (before, after) = (operand_before(cond, i), operand_after(cond, end));
                sides.push(if cond[i] == b'<' {
                    (before, after)
                } else {
                    (after, before)
                });
            }
            i = end;
        } else {
            i += 1;
        }
    }
    sides
}

fn operand_before(cond: &[u8], op: usize) -> &[u8] {
    let mut depth = 0;
    let mut i = op;
    while i > 0 {
        match cond[i - 1] {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth == 0 => break,
            b'(' | b'[' | b'{' => depth -= 1,
            b',' if depth == 0 => break,
            b'&' | b'|' if depth == 0 && i >= 2 && cond[i - 2] == cond[i - 1] => break,
            _ => {}
        }
        i -= 1;
    }
    &cond[i..op]
}

/// The expression from `from` to the next `,`, `;`, `|` or `&&` outside brackets, or the bracket
/// that closes around it.
fn operand_after(cond: &[u8], from: usize) -> &[u8] {
    let mut depth = 0;
    let mut i = from;
    while i < cond.len() {
        match cond[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => break,
            b')' | b']' | b'}' => depth -= 1,
            b',' | b';' | b'|' if depth == 0 => break,
            b'&' if depth == 0 && cond.get(i + 1) == Some(&b'&') => break,
            _ => {}
        }
        i += 1;
    }
    &cond[from..i]
}

/// What an expression reads off the clock.
enum Clock<'a> {
    /// A span measured earlier, or the difference of two instants taken earlier.
    Span,
    /// The time since the instants named, measured now: `start.elapsed()`, `Instant::now() - start`.
    Since(Vec<&'a [u8]>),
    /// The clock now, against the instants the other side of the comparison names: `Instant::now()
    /// < deadline`.
    Now(Vec<&'a [u8]>),
}

/// What `expr` reads off the clock where it stands ([`standing`]), its names looked up from `at`.
fn clock<'a>(expr: &'a [u8], other: &'a [u8], at: usize, names: &Names<'_>) -> Option<Clock<'a>> {
    let stands = standing(expr);
    let mut last = None;
    for (i, name, after) in idents(expr) {
        let receiver = last.replace(name);
        if !stands[i] {
            continue;
        }
        let field = expr[..i].ends_with(b".");
        if field && name == b"elapsed" && after.starts_with(b"()") {
            return Some(Clock::Since(receiver.into_iter().collect()));
        }
        if name == b"Instant" && after.starts_with(b"::now()") {
            let rest = after[7..].trim_ascii_start();
            let starts = |s: &'a [u8]| idents(s).map(|(_, n, _)| n).collect();
            return Some(if differs(rest) {
                Clock::Since(starts(rest))
            } else {
                Clock::Now(starts(other))
            });
        }
        let after = after.trim_ascii_start();
        if expr[..i].ends_with(b"::")
            || [&b"("[..], b"!", b"::"]
                .iter()
                .any(|s| after.starts_with(s))
        {
            continue;
        }
        let span = if field {
            names.field(name)
        } else {
            names.span(name, at) || (names.instant(name, at) && differs(after))
        };
        if span {
            return Some(Clock::Span);
        }
    }
    None
}

/// For each byte of `expr`, whether a term there stands in `expr` itself, so that a bound on `expr`
/// bounds it from above: not inside a call's arguments, an index, a block or a struct, and not
/// after a `-` or a `/` that may subtract it or divide by it.
fn standing(expr: &[u8]) -> Vec<bool> {
    let mut frames = vec![true];
    let mut stands = Vec::with_capacity(expr.len());
    for (i, &c) in expr.iter().enumerate() {
        let open = frames.last().copied().unwrap_or(false);
        match c {
            b'(' => {
                let call = expr[..i]
                    .trim_ascii_end()
                    .last()
                    .is_some_and(|&p| ident(p) || b")]>!".contains(&p));
                frames.push(open && !call);
            }
            b'[' | b'{' => frames.push(false),
            b')' | b']' | b'}' if frames.len() > 1 => {
                frames.pop();
            }
            b'-' | b'/' if expr.get(i + 1) != Some(&b'>') => {
                if let Some(f) = frames.last_mut() {
                    *f = false;
                }
            }
            _ => {}
        }
        stands.push(frames.last().copied().unwrap_or(false));
    }
    stands
}

/// Whether what follows an instant subtracts another from it.
fn differs(after: &[u8]) -> bool {
    (after.starts_with(b"-") && !after.starts_with(b"->") && !after.starts_with(b"-="))
        || after.starts_with(b".duration_since(")
        || after.starts_with(b".saturating_duration_since(")
}

/// Whether a clock read at `at` is a polling loop's ceiling: inside a loop, against instants none
/// of which that loop takes again on each pass.
fn hang_guard(at: usize, starts: &[&[u8]], loops: &[Range<usize>], names: &Names<'_>) -> bool {
    let Some(inner) = loops
        .iter()
        .filter(|l| l.contains(&at))
        .min_by_key(|l| l.len())
    else {
        return false;
    };
    !starts
        .iter()
        .any(|s| names.visible(s, at).iter().any(|b| inner.contains(&b.at)))
}

#[cfg(test)]
mod tests {
    use super::findings;

    fn lines(src: &str) -> Vec<usize> {
        findings(src).into_iter().map(|(line, _)| line).collect()
    }

    /// The shapes of the bounds that failed on loaded machines before #100 and in #131.
    #[test]
    fn finds_an_upper_bound_on_real_time_in_each_shape_a_past_failure_took() {
        let src = r#"fn a() {
    let t = Instant::now();
    assert!(t.elapsed() < Duration::from_millis(900));
}
fn b<'a>(s: &'a str) {
    let started = Instant::now();
    let q = '"';
    let r = Reply { took: started.elapsed(), body: "assert!(" };
    assert!(r.took < delay, "refused without waiting: {:?}", r.took);
}
fn c() {
    let closed_after = started.elapsed();
    assert!(
        closed_after >= Duration::from_secs(1) && closed_after < Duration::from_millis(1600),
        "{closed_after:?}"
    );
}
fn d() {
    let at = Instant::now();
    debug_assert!(Duration::from_millis(100) > at - announced);
    assert!(Instant::now().duration_since(at) <= LIMIT);
    assert! { t.elapsed() < LIMIT };
    assert![t.elapsed() < LIMIT];
}
"#;
        assert_eq!(lines(src), [3, 9, 13, 20, 21, 22, 23]);
    }

    /// A budget inside a loop is still a budget: each pass takes its own start, or measured a span,
    /// or the loop runs a fixed count of passes.
    #[test]
    fn finds_a_budget_on_each_pass_of_a_loop_and_a_deadline_checked_after_the_event() {
        let src = r#"fn per_pass() {
    for _ in 0..20 {
        let start = Instant::now();
        read();
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    for delay in [0, 500] {
        let at = pushed.elapsed();
        assert!(at < Duration::from_millis(delay) + late, "{at:?}");
    }
}
fn after() {
    let deadline = Instant::now() + Duration::from_secs(2);
    shut_down().await;
    assert!(Instant::now() < deadline, "too slow");
}
impl Wait for Gate {
    fn wait(&self, at: Instant) {
        assert!(at.elapsed() < self.limit);
    }
}
fn every_pass() {
    let started = Instant::now();
    for _ in 0..100 {
        work();
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
"#;
        assert_eq!(lines(src), [5, 9, 15, 19, 26]);
    }

    /// A name is what Rust binds it to where it is read: not a span measured in another function,
    /// in a block that has closed, or under a `let` that a later one shadows.
    #[test]
    fn a_name_is_the_binding_in_scope_where_it_is_read() {
        let src = r#"fn measured() {
    let total = started.elapsed();
    let n = started.elapsed();
    took = started.elapsed();
}
fn counted(took: u64) {
    let total = 1 + 2;
    assert!(total < 10);
    assert!(took < 10);
}
fn shadowed() {
    let n = started.elapsed();
    {
        let n = 3;
        assert!(n < 10);
    }
    for n in 0..3 {
        assert!(n < 10);
    }
    if let Some(n) = sample {
        assert!(n < 10);
    }
    assert!(n < LIMIT);
    let n = 4;
    assert!(n < 10);
}
"#;
        assert_eq!(lines(src), [23]);
    }

    /// An assignment measures the `let` it writes, and only for what reads it afterwards.
    #[test]
    fn an_assignment_measures_its_own_binding_from_there_on() {
        let src = r#"fn rows() {
    let count = rows.len();
    {
        let mut count = 0;
        count = start.elapsed().as_millis();
    }
    assert!(count < 4);
}
fn later() {
    let mut took = Duration::ZERO;
    assert!(took < LIMIT);
    took = started.elapsed();
    assert!(took < LIMIT);
}
"#;
        assert_eq!(lines(src), [13]);
    }

    /// A tokio pause makes a bound exact only for tokio's clock, and only while it lasts.
    #[test]
    fn a_paused_test_that_reads_a_real_clock_is_not_exempt() {
        let src = r#"use std::time::{Duration, Instant};
#[tokio::test(start_paused = true)]
async fn std_instant() {
    let t = Instant::now();
    assert!(t.elapsed() < Duration::from_secs(1));
}
#[tokio::test(start_paused = true)]
async fn qualified() {
    let t = std::time::Instant::now();
    assert!(t.elapsed() < Duration::from_secs(1));
}
#[tokio::test]
async fn resumed() {
    tokio::time::pause();
    assert!(at.elapsed() < Duration::from_secs(1));
    tokio::time::resume();
    assert!(at.elapsed() < Duration::from_secs(1));
}
#[tokio::test]
async fn paused_late() {
    assert!(at.elapsed() < Duration::from_secs(1));
    tokio::time::pause();
}
mod tests {
    use tokio::time::Instant;
    #[tokio::test(start_paused = true)]
    async fn tokio_instant() {
        let t = Instant::now();
        assert!(t.elapsed() < Duration::from_secs(1));
    }
}
"#;
        assert_eq!(lines(src), [5, 10, 17, 21]);
    }

    #[test]
    fn leaves_lower_bounds_wait_ceilings_and_ignored_or_paused_tests_alone() {
        let src = r##"fn lower() {
    assert!(started.elapsed() >= Duration::from_secs(1), "closed too soon");
    assert!(Duration::from_secs(1) <= took);
}
fn ceiling() {
    let deadline = Instant::now() + WAIT;
    loop {
        if done() {
            break;
        }
        assert!(Instant::now() < deadline, "never done");
    }
    let started = Instant::now();
    for (i, header) in blocks.iter().enumerate() {
        if dropped() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(30), "never dropped");
        while served() == before {
            assert!(started.elapsed() < Duration::from_secs(30), "never dropped");
        }
    }
    while started.elapsed() < Duration::from_secs(30) {}
}
#[tokio::test(start_paused = true)]
async fn paused() {
    assert!(at.elapsed() < Duration::from_secs(1));
}
#[tokio::test]
async fn paused_inside() {
    tokio::time::pause();
    assert!(at.elapsed() < Duration::from_secs(1));
}
/// `cargo test -- --ignored budget`
#[test]
#[ignore = "a time budget: a busy machine fails it for no fault of the code"]
pub(crate) async fn budget() {
    let build = started.elapsed();
    assert!(build < Duration::from_secs(3), "{build:?}");
}
fn words() {
    // assert!(t.elapsed() < Duration::from_millis(1));
    let s = r#"assert!(t.elapsed() < Duration::from_millis(1))"#;
    assert!(heights.len() < 5 && a <= b);
    assert!(rate as f64 <= 30.0 + 2.0 * elapsed);
}
"##;
        assert_eq!(lines(src), Vec::<usize>::new());
    }

    /// Code that bounds no time from above: instants compared for their order, a span subtracted or
    /// divided into, one part of a destructured value, and a read inside a struct or a closure.
    #[test]
    fn leaves_values_that_bound_no_span_from_above_alone() {
        let src = r#"fn order() {
    let first = Instant::now();
    let deadline = Instant::now() + WAIT;
    assert!(first < second && deadline > first);
}
fn inverted() {
    let rate = sent as f64 / started.elapsed().as_secs_f64();
    assert!(rate < 100.0);
    assert!(sent - 2 * started.elapsed().as_secs() <= 30);
    assert!(deadline - Instant::now() < WAIT);
}
fn parts() {
    let (count, took) = (items.len(), started.elapsed());
    assert!(count < 10);
    let r = Reply { took: started.elapsed(), status: 200 };
    assert!(r.status < 500);
    let fresh = seen.iter().filter(|s| s.at.elapsed() > TTL).count();
    assert!(fresh < 3);
}
"#;
        assert_eq!(lines(src), Vec::<usize>::new());
    }
}
