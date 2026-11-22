//! A test never passes or fails on how long something took on the machine that runs it (docs/CI.md
//! "Rules for tests"). This finds the form of that mistake the source shows: an assertion that a
//! span of real time stayed under a bound.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::collections::HashSet;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

const FIX: &str = "\
These assertions put an upper bound on how long real time took, so a slow or busy machine fails \
them for no fault of the code (docs/CI.md \"Rules for tests\"). Instead:
  - wait for the event the test means (a reply, a log line, a gate the test opens) and assert what \
happened, not how soon;
  - or run the test on tokio's paused clock, #[tokio::test(start_paused = true)] or \
tokio::time::pause(), where a timer's spacing is exact;
  - or, for a speed budget, give it a test of its own under #[ignore = \"a time budget: ...\"] with \
the command that runs it in its doc comment, and keep a test of the same answers, without the \
clock, in the suite.
A polling loop's ceiling is no budget, as it fails only when the event never comes: take the start \
or the deadline before the loop and check it inside, `assert!(started.elapsed() < WAIT, \"never \
...\")`.";

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
    let exempt: Vec<Range<usize>> = functions(&code)
        .into_iter()
        .filter(|f| f.exempt)
        .map(|f| f.body)
        .collect();
    let bound = bindings(&code);
    let (instants, spans) = clock_names(&bound);
    let loops = loops(&code);
    let mut found = Vec::new();
    for (at, cond) in assertions(&code) {
        let cond = &code[cond];
        let budget = comparisons(cond).into_iter().any(|(lesser, greater)| {
            match clock(lesser, greater, &spans, &instants) {
                None => false,
                Some(Clock::Span) => true,
                Some(Clock::Since(starts)) => !hang_guard(at, &starts, &loops, &bound),
            }
        });
        if budget && !exempt.iter().any(|f| f.contains(&at)) {
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

/// Where `word` stands on its own in `code`.
fn words<'a>(code: &'a [u8], word: &'a [u8]) -> impl Iterator<Item = usize> + 'a {
    (0..=code.len().saturating_sub(word.len())).filter(move |&i| {
        code[i..].starts_with(word)
            && (i == 0 || !ident(code[i - 1]))
            && code.get(i + word.len()).is_none_or(|&c| !ident(c))
    })
}

/// The identifiers in `code`, each with what follows it.
fn idents(code: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    (0..code.len())
        .filter(|&i| ident(code[i]) && !code[i].is_ascii_digit() && (i == 0 || !ident(code[i - 1])))
        .map(|i| {
            let end = code[i..]
                .iter()
                .position(|&c| !ident(c))
                .map_or(code.len(), |n| i + n);
            (&code[i..end], &code[end..])
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

struct Function {
    body: Range<usize>,
    /// An ignored test, or one on tokio's paused clock, where a bound on time is exact.
    exempt: bool,
}

fn functions(code: &[u8]) -> Vec<Function> {
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
            let exempt = words(attributes, b"ignore").next().is_some()
                || find(&tight, b"start_paused=true").is_some()
                || find(&code[body.clone()], b"time::pause()").is_some();
            Some(Function { body, exempt })
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

/// The bodies of the `loop`, `while` and `for` loops in `code`.
fn loops(code: &[u8]) -> Vec<Range<usize>> {
    let statement = |at: usize| {
        let before = code[..at].trim_ascii_end();
        let after = code[at + 3..].trim_ascii_start();
        // Not `impl Trait for Type` or `for<'a>`.
        before.last().is_none_or(|c| b";{}:".contains(c)) && !after.starts_with(b"<")
    };
    words(code, b"loop")
        .chain(words(code, b"while"))
        .chain(words(code, b"for").filter(|&at| statement(at)))
        .filter_map(|at| block_after(code, at))
        .collect()
}

/// A name a `let`, an assignment or a struct field binds: where, and the value bound.
struct Binding<'a> {
    name: &'a [u8],
    at: usize,
    value: &'a [u8],
}

fn bindings(code: &[u8]) -> Vec<Binding<'_>> {
    let mut found = Vec::new();
    for at in words(code, b"let") {
        let before = code[..at].trim_ascii_end();
        if [&b"if"[..], b"while", b"&&"]
            .iter()
            .any(|w| before.ends_with(w))
        {
            continue;
        }
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
        let pattern = pattern
            .iter()
            .position(|&c| c == b':')
            .map_or(pattern, |p| &pattern[..p]);
        let value = &code[eq + 1..end];
        found.extend(
            pattern
                .split(|&c| !ident(c))
                .filter(|w| !w.is_empty() && *w != b"mut" && *w != b"ref")
                .map(|name| Binding { name, at, value }),
        );
    }
    // `took: started.elapsed(),` in a struct and `took = started.elapsed();`, one to a line.
    let mut start = 0;
    for line in code.split(|&c| c == b'\n') {
        let at = start + line.len() - line.trim_ascii_start().len();
        start += line.len() + 1;
        let line = line.trim_ascii_start();
        let name_end = line.iter().position(|&c| !ident(c)).unwrap_or(line.len());
        let rest = &line[name_end..];
        if name_end > 0 && (rest.starts_with(b": ") || rest.starts_with(b" = ")) {
            found.push(Binding {
                name: &line[..name_end],
                at,
                value: &rest[2..],
            });
        }
    }
    found
}

/// The names bound to an instant read off the clock, and those bound to a span measured on it.
fn clock_names(bound: &[Binding<'_>]) -> (HashSet<Vec<u8>>, HashSet<Vec<u8>>) {
    let instants: HashSet<Vec<u8>> = bound
        .iter()
        .filter(|b| find(b.value, b"Instant::now()").is_some() && !b.value.contains(&b'+'))
        .map(|b| b.name.to_vec())
        .collect();
    let none = HashSet::new();
    let spans = bound
        .iter()
        .filter(|b| clock(b.value, &[], &none, &instants).is_some())
        .map(|b| b.name.to_vec())
        .collect();
    (instants, spans)
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
        if code[open] != b'(' {
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

fn operand_after(cond: &[u8], from: usize) -> &[u8] {
    let mut depth = 0;
    let mut i = from;
    while i < cond.len() {
        match cond[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' if depth == 0 => break,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => break,
            b'&' | b'|' if depth == 0 && cond.get(i + 1) == Some(&cond[i]) => break,
            _ => {}
        }
        i += 1;
    }
    &cond[from..i]
}

/// What the lesser side of a comparison reads off the clock.
enum Clock<'a> {
    /// A span measured earlier, or the difference of two instants taken earlier.
    Span,
    /// The clock now, against the instants named: `start.elapsed() < WAIT`, `Instant::now() <
    /// deadline`.
    Since(Vec<&'a [u8]>),
}

fn clock<'a>(
    lesser: &'a [u8],
    greater: &'a [u8],
    spans: &HashSet<Vec<u8>>,
    instants: &HashSet<Vec<u8>>,
) -> Option<Clock<'a>> {
    if let Some(p) = find(lesser, b".elapsed()") {
        let receiver = idents(&lesser[..p]).last().map(|(name, _)| name);
        return Some(Clock::Since(receiver.into_iter().collect()));
    }
    for (name, after) in idents(lesser) {
        let after = after.trim_ascii_start();
        if spans.contains(name) {
            return Some(Clock::Span);
        }
        if name == b"Instant" && after.starts_with(b"::now()") {
            let rest = after[7..].trim_ascii_start();
            let against = if differs(rest) { rest } else { greater };
            return Some(Clock::Since(idents(against).map(|(n, _)| n).collect()));
        }
        if instants.contains(name) && differs(after) {
            return Some(Clock::Span);
        }
    }
    None
}

/// Whether what follows an instant subtracts another from it.
fn differs(after: &[u8]) -> bool {
    (after.starts_with(b"-") && !after.starts_with(b"->") && !after.starts_with(b"-="))
        || after.starts_with(b".duration_since(")
        || after.starts_with(b".saturating_duration_since(")
}

/// Whether a clock read at `at` is a polling loop's ceiling: inside a loop, against instants none
/// of which that loop takes again on each pass.
fn hang_guard(at: usize, starts: &[&[u8]], loops: &[Range<usize>], bound: &[Binding<'_>]) -> bool {
    let Some(inner) = loops
        .iter()
        .filter(|l| l.contains(&at))
        .min_by_key(|l| l.len())
    else {
        return false;
    };
    !bound
        .iter()
        .any(|b| starts.contains(&b.name) && inner.contains(&b.at) && b.at < at)
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
}
"#;
        assert_eq!(lines(src), [3, 9, 13, 20, 21]);
    }

    /// A budget inside a loop is still a budget: each pass takes its own start, or measured a span.
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
"#;
        assert_eq!(lines(src), [5, 9, 15, 19]);
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
}
