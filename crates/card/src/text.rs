//! Text in the site's Recursive Mono, at the two weights a card uses: outlines read with
//! `ttf-parser` from the subset fonts in `fonts/` (made by `design/fonts/card-subset.py`) and
//! filled by the painter. Every advance is 0.6 em but the narrow no-break space's 0.15 em.

use std::sync::OnceLock;

use ttf_parser::{Face, GlyphId, OutlineBuilder};

use crate::paint::{Canvas, P, Path, Rgb, p};

static REGULAR: &[u8] = include_bytes!("../fonts/recursive-mono-400.ttf");
static BOLD: &[u8] = include_bytes!("../fonts/recursive-mono-600.ttf");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Weight {
    /// 400
    Regular,
    /// 600
    Bold,
}

fn face(weight: Weight) -> Option<&'static Face<'static>> {
    static FACES: OnceLock<(Option<Face<'static>>, Option<Face<'static>>)> = OnceLock::new();
    let (regular, bold) =
        FACES.get_or_init(|| (Face::parse(REGULAR, 0).ok(), Face::parse(BOLD, 0).ok()));
    match weight {
        Weight::Regular => regular.as_ref(),
        Weight::Bold => bold.as_ref(),
    }
}

/// Characters the font lacks that a pool name holds, drawn as shapes of our own in a mono cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Symbol {
    /// ⛏ U+26CF
    Pick,
    /// ⚡ U+26A1
    Bolt,
}

/// What one character is drawn as.
enum Mark {
    Glyph(GlyphId, f32),
    Symbol(Symbol),
    /// Takes no room: the emoji variation selector U+FE0F.
    Nothing,
    Missing,
}

/// Em widths are in thousandths, the fonts' units per em.
const UNITS: f32 = 1000.0;
const CELL: f32 = 600.0;

fn mark(face: &Face<'_>, c: char) -> Mark {
    match c {
        '\u{26cf}' => return Mark::Symbol(Symbol::Pick),
        '\u{26a1}' => return Mark::Symbol(Symbol::Bolt),
        '\u{fe0f}' => return Mark::Nothing,
        _ => {}
    }
    match face.glyph_index(c) {
        Some(g) => Mark::Glyph(g, f32::from(face.glyph_hor_advance(g).unwrap_or(0))),
        None => Mark::Missing,
    }
}

/// Characters of `text` the card cannot draw.
#[cfg(test)]
pub(crate) fn missing(text: &str) -> Vec<char> {
    let mut out = Vec::new();
    for weight in [Weight::Regular, Weight::Bold] {
        let Some(face) = face(weight) else {
            return text.chars().collect();
        };
        for c in text.chars() {
            if matches!(mark(face, c), Mark::Missing) && !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// How wide `text` is at `size` px.
pub(crate) fn width(text: &str, size: f32) -> f32 {
    let Some(face) = face(Weight::Regular) else {
        return 0.0;
    };
    text.chars()
        .map(|c| match mark(face, c) {
            Mark::Glyph(_, advance) => advance,
            Mark::Symbol(_) | Mark::Missing => CELL,
            Mark::Nothing => 0.0,
        })
        .sum::<f32>()
        * size
        / UNITS
}

/// Glyph outlines into a path, scaled and placed, with y turned to point down.
struct Builder<'a> {
    path: &'a mut Path,
    x: f32,
    y: f32,
    scale: f32,
}

impl Builder<'_> {
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (self.x + x * self.scale, self.y - y * self.scale)
    }
}

impl OutlineBuilder for Builder<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.path.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.path.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x1, y1) = self.at(x1, y1);
        let (x, y) = self.at(x, y);
        self.path.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x1, y1) = self.at(x1, y1);
        let (x2, y2) = self.at(x2, y2);
        let (x, y) = self.at(x, y);
        self.path.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.path.close();
    }
}

/// Draws `text` with its baseline's left end at (`x`, `y`), and returns where it ends.
pub(crate) fn draw(
    canvas: &mut Canvas,
    text: &str,
    x: f32,
    y: f32,
    size: f32,
    weight: Weight,
    color: Rgb,
) -> f32 {
    let Some(face) = face(weight) else {
        return x;
    };
    let scale = size / UNITS;
    let mut path = Path::default();
    let mut symbols = Path::default();
    let mut pen = x;
    for c in text.chars() {
        match mark(face, c) {
            Mark::Glyph(g, advance) => {
                let mut b = Builder {
                    path: &mut path,
                    x: pen,
                    y,
                    scale,
                };
                face.outline_glyph(g, &mut b);
                path.close();
                pen += advance * scale;
            }
            Mark::Symbol(s) => {
                symbols.add(symbol(s, pen, y, size, weight), false);
                pen += CELL * scale;
            }
            Mark::Missing => pen += CELL * scale,
            Mark::Nothing => {}
        }
    }
    canvas.fill(&path, color, 1.0);
    canvas.fill(&symbols, color, 1.0);
    pen
}

/// A symbol in the mono cell whose baseline starts at (`x`, `y`), the size of a capital.
fn symbol(s: Symbol, x: f32, y: f32, size: f32, weight: Weight) -> Path {
    let em = |u: f32, v: f32| -> P { p(x + u * size, y - v * size) };
    let line = match weight {
        Weight::Regular => 0.07,
        Weight::Bold => 0.095,
    } * size;
    match s {
        Symbol::Bolt => Path::polygon(&[
            em(0.36, 0.72),
            em(0.12, 0.31),
            em(0.29, 0.31),
            em(0.21, -0.02),
            em(0.48, 0.42),
            em(0.31, 0.42),
            em(0.42, 0.72),
        ]),
        Symbol::Pick => {
            // A handle from the lower left, and the head across its top end, arched away from it.
            let mut path = crate::paint::stroke(&[em(0.1, 0.0), em(0.41, 0.6)], line, true);
            let mut head = Path::default();
            let (a, c, b) = (em(0.12, 0.66), em(0.47, 0.74), em(0.6, 0.4));
            head.move_to(a.x, a.y);
            head.quad_to(c.x, c.y, b.x, b.y);
            path.add(crate::paint::stroke_curve(&head, line * 1.3), false);
            path
        }
    }
}
