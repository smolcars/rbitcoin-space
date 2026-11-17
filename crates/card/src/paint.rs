//! A small painter: outlines of lines and Bézier curves filled with anti-aliased coverage from
//! `ab_glyph_rasterizer` (signed area per pixel), composited onto an RGB canvas. Strokes,
//! rounded rectangles, circles and dashes are built here as outlines.
//!
//! Outlines that are unioned in one fill all wind the same way (clockwise on screen); a hole
//! winds the other way, so its area cancels.

use ab_glyph_rasterizer::{Rasterizer, point};

/// An sRGB colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rgb(pub u8, pub u8, pub u8);

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct P {
    pub x: f32,
    pub y: f32,
}

pub(crate) const fn p(x: f32, y: f32) -> P {
    P { x, y }
}

#[derive(Debug, Clone, Copy)]
enum Seg {
    Line(P, P),
    Quad(P, P, P),
    Cubic(P, P, P, P),
}

impl Seg {
    fn reversed(self) -> Self {
        match self {
            Self::Line(a, b) => Self::Line(b, a),
            Self::Quad(a, b, c) => Self::Quad(c, b, a),
            Self::Cubic(a, b, c, d) => Self::Cubic(d, c, b, a),
        }
    }

    fn points(&self) -> impl Iterator<Item = P> {
        let (a, b, c, d) = match *self {
            Self::Line(a, b) => (a, b, a, b),
            Self::Quad(a, b, c) => (a, b, c, c),
            Self::Cubic(a, b, c, d) => (a, b, c, d),
        };
        [a, b, c, d].into_iter()
    }
}

/// Closed outlines to fill together.
#[derive(Debug, Default, Clone)]
pub(crate) struct Path {
    segs: Vec<Seg>,
    start: Option<P>,
    at: P,
}

/// How far a cubic's control points sit along the tangent for a quarter circle.
const KAPPA: f32 = 0.552_284_8;

impl Path {
    pub fn move_to(&mut self, x: f32, y: f32) {
        self.close();
        self.start = Some(p(x, y));
        self.at = p(x, y);
    }

    pub fn line_to(&mut self, x: f32, y: f32) {
        self.segs.push(Seg::Line(self.at, p(x, y)));
        self.at = p(x, y);
    }

    pub fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.segs.push(Seg::Quad(self.at, p(x1, y1), p(x, y)));
        self.at = p(x, y);
    }

    pub fn cubic_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.segs
            .push(Seg::Cubic(self.at, p(x1, y1), p(x2, y2), p(x, y)));
        self.at = p(x, y);
    }

    /// Ends the current outline with a line back to its start.
    pub fn close(&mut self) {
        if let Some(s) = self.start.take()
            && s != self.at
        {
            self.segs.push(Seg::Line(self.at, s));
            self.at = s;
        }
    }

    /// Appends `other`'s outlines, reversed when `hole`.
    pub fn add(&mut self, mut other: Path, hole: bool) {
        self.close();
        other.close();
        if hole {
            self.segs
                .extend(other.segs.into_iter().rev().map(Seg::reversed));
        } else {
            self.segs.extend(other.segs);
        }
    }

    pub fn polygon(points: &[P]) -> Self {
        let mut path = Self::default();
        let mut it = points.iter();
        if let Some(first) = it.next() {
            path.move_to(first.x, first.y);
            for q in it {
                path.line_to(q.x, q.y);
            }
            path.close();
        }
        // The shoelace sum is positive for a clockwise outline in screen coordinates.
        let area: f32 = points
            .iter()
            .zip(points.iter().cycle().skip(1))
            .map(|(a, b)| a.x * b.y - b.x * a.y)
            .sum();
        if area < 0.0 {
            let mut out = Self::default();
            out.add(path, true);
            return out;
        }
        path
    }

    pub fn rect(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self::polygon(&[p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h)])
    }

    /// A rectangle with corners of radius `r`, clockwise from the top edge's left end, as an
    /// SVG `rect` with `rx` starts.
    pub fn rounded(x: f32, y: f32, w: f32, h: f32, r: f32) -> Self {
        let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
        let k = r * (1.0 - KAPPA);
        let (x2, y2) = (x + w, y + h);
        let mut path = Self::default();
        path.move_to(x + r, y);
        path.line_to(x2 - r, y);
        path.cubic_to(x2 - k, y, x2, y + k, x2, y + r);
        path.line_to(x2, y2 - r);
        path.cubic_to(x2, y2 - k, x2 - k, y2, x2 - r, y2);
        path.line_to(x + r, y2);
        path.cubic_to(x + k, y2, x, y2 - k, x, y2 - r);
        path.line_to(x, y + r);
        path.cubic_to(x, y + k, x + k, y, x + r, y);
        path.close();
        path
    }

    pub fn circle(cx: f32, cy: f32, r: f32) -> Self {
        let k = r * KAPPA;
        let mut path = Self::default();
        path.move_to(cx + r, cy);
        path.cubic_to(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
        path.cubic_to(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
        path.cubic_to(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
        path.cubic_to(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
        path.close();
        path
    }

    /// The outline of a rounded rectangle's border `width` wide, centred on its edge.
    pub fn rounded_ring(x: f32, y: f32, w: f32, h: f32, r: f32, width: f32) -> Self {
        let o = width / 2.0;
        let mut path = Self::rounded(x - o, y - o, w + width, h + width, r + o);
        path.add(
            Self::rounded(x + o, y + o, w - width, h - width, (r - o).max(0.0)),
            true,
        );
        path
    }

    /// A circle's border `width` wide, centred on radius `r`.
    pub fn ring(cx: f32, cy: f32, r: f32, width: f32) -> Self {
        let o = width / 2.0;
        let mut path = Self::circle(cx, cy, r + o);
        path.add(Self::circle(cx, cy, (r - o).max(0.0)), true);
        path
    }

    /// The points a polyline through this path's segments passes, each curve cut in `steps`.
    /// For open strokes: only meaningful on a path built of one unclosed outline.
    fn flatten(&self, steps: usize) -> Vec<P> {
        let mut out: Vec<P> = Vec::new();
        for seg in &self.segs {
            let pts: Vec<P> = seg.points().collect();
            let first = pts.first().copied().unwrap_or(p(0.0, 0.0));
            if out.last() != Some(&first) {
                out.push(first);
            }
            match *seg {
                Seg::Line(_, b) => out.push(b),
                Seg::Quad(a, b, c) => {
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        let u = 1.0 - t;
                        out.push(p(
                            u * u * a.x + 2.0 * u * t * b.x + t * t * c.x,
                            u * u * a.y + 2.0 * u * t * b.y + t * t * c.y,
                        ));
                    }
                }
                Seg::Cubic(a, b, c, d) => {
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        let u = 1.0 - t;
                        let (w0, w1, w2, w3) =
                            (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                        out.push(p(
                            w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x,
                            w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y,
                        ));
                    }
                }
            }
        }
        out
    }
}

/// An open line through `points`, `width` wide: round caps and joins when `round`, else butt
/// ends and the segments simply overlapping at each bend.
pub(crate) fn stroke(points: &[P], width: f32, round: bool) -> Path {
    let hw = width / 2.0;
    let mut path = Path::default();
    for (a, b) in points.iter().zip(points.iter().skip(1)) {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-4 {
            continue;
        }
        let (nx, ny) = (-dy / len * hw, dx / len * hw);
        path.add(
            Path::polygon(&[
                p(a.x + nx, a.y + ny),
                p(b.x + nx, b.y + ny),
                p(b.x - nx, b.y - ny),
                p(a.x - nx, a.y - ny),
            ]),
            false,
        );
    }
    if round {
        for q in points {
            path.add(Path::circle(q.x, q.y, hw), false);
        }
    }
    path
}

/// A curve, flattened, stroked with round caps and joins.
pub(crate) fn stroke_curve(curve: &Path, width: f32) -> Path {
    stroke(&curve.flatten(16), width, true)
}

/// The dashes of a rounded rectangle's border, 10 px long and 8 apart from the start of its
/// top edge, as SVG's `stroke-dasharray="10 8"` lays them.
pub(crate) fn dashed_rounded(x: f32, y: f32, w: f32, h: f32, r: f32, width: f32) -> Path {
    let (on, off) = (10.0, 8.0);
    let perimeter = Path::rounded(x, y, w, h, r).flatten(8);
    let mut path = Path::default();
    let (mut drawing, mut left) = (true, on);
    let mut dash: Vec<P> = Vec::new();
    if let Some(first) = perimeter.first() {
        dash.push(*first);
    }
    for (a, b) in perimeter.iter().zip(perimeter.iter().skip(1)) {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let len = (dx * dx + dy * dy).sqrt();
        let mut done = 0.0;
        while len - done > left {
            done += left;
            let t = done / len;
            let q = p(a.x + dx * t, a.y + dy * t);
            if drawing {
                dash.push(q);
                path.add(stroke(&dash, width, false), false);
                dash.clear();
            } else {
                dash.push(q);
            }
            drawing = !drawing;
            left = if drawing { on } else { off };
        }
        left -= len - done;
        if drawing {
            dash.push(*b);
        }
    }
    if drawing && dash.len() > 1 {
        path.add(stroke(&dash, width, false), false);
    }
    path
}

/// The picture being drawn: RGB, row by row.
pub(crate) struct Canvas {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(width: usize, height: usize, bg: Rgb) -> Self {
        let mut pixels = Vec::with_capacity(width * height * 3);
        for _ in 0..width * height {
            pixels.extend_from_slice(&[bg.0, bg.1, bg.2]);
        }
        Self {
            width,
            height,
            pixels,
        }
    }

    /// Fills `path` in `color` at `opacity`, anti-aliased.
    pub fn fill(&mut self, path: &Path, color: Rgb, opacity: f32) {
        let mut path = path.clone();
        path.close();
        let (mut lo, mut hi) = (p(f32::MAX, f32::MAX), p(f32::MIN, f32::MIN));
        for q in path.segs.iter().flat_map(Seg::points) {
            if !(q.x.is_finite() && q.y.is_finite()) {
                return;
            }
            lo = p(lo.x.min(q.x), lo.y.min(q.y));
            hi = p(hi.x.max(q.x), hi.y.max(q.y));
        }
        // Only what can land on the canvas is rasterized; a margin keeps edges off the border.
        let x0 = lo.x.floor().max(-1.0) - 1.0;
        let y0 = lo.y.floor().max(-1.0) - 1.0;
        let x1 = hi.x.ceil().min(self.width as f32 + 1.0) + 1.0;
        let y1 = hi.y.ceil().min(self.height as f32 + 1.0) + 1.0;
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let (w, h) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let mut r = Rasterizer::new(w, h);
        let at = |q: P| {
            point(
                (q.x - x0).clamp(0.0, w as f32),
                (q.y - y0).clamp(0.0, h as f32),
            )
        };
        for seg in &path.segs {
            match *seg {
                Seg::Line(a, b) => r.draw_line(at(a), at(b)),
                Seg::Quad(a, b, c) => r.draw_quad(at(a), at(b), at(c)),
                Seg::Cubic(a, b, c, d) => r.draw_cubic(at(a), at(b), at(c), at(d)),
            }
        }
        let (ox, oy) = (x0 as i64, y0 as i64);
        let (cw, ch) = (self.width as i64, self.height as i64);
        r.for_each_pixel_2d(|x, y, coverage| {
            // Overlapping outlines wound the same way add up past full coverage.
            let a = coverage.min(1.0) * opacity;
            if a.is_nan() || a <= 0.0 {
                return;
            }
            let (px, py) = (ox + i64::from(x), oy + i64::from(y));
            if px < 0 || py < 0 || px >= cw || py >= ch {
                return;
            }
            let i = ((py * cw + px) * 3) as usize;
            if let Some(dst) = self.pixels.get_mut(i..i + 3) {
                for (d, s) in dst.iter_mut().zip([color.0, color.1, color.2]) {
                    let v = f32::from(*d) * (1.0 - a) + f32::from(s) * a;
                    *d = v.round().clamp(0.0, 255.0) as u8;
                }
            }
        });
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn at(c: &Canvas, x: usize, y: usize) -> [u8; 3] {
        let i = (y * c.width + x) * 3;
        [c.pixels[i], c.pixels[i + 1], c.pixels[i + 2]]
    }

    #[test]
    fn a_rectangle_on_whole_pixels_is_crisp_and_on_half_pixels_is_blended() {
        let mut c = Canvas::new(10, 10, Rgb(255, 255, 255));
        c.fill(&Path::rect(2.0, 2.0, 3.0, 3.0), Rgb(0, 0, 0), 1.0);
        assert_eq!(at(&c, 2, 2), [0, 0, 0]);
        assert_eq!(at(&c, 4, 4), [0, 0, 0]);
        assert_eq!(at(&c, 5, 5), [255, 255, 255]);
        assert_eq!(at(&c, 1, 3), [255, 255, 255]);
        let mut c = Canvas::new(10, 10, Rgb(255, 255, 255));
        c.fill(&Path::rect(2.5, 2.0, 3.0, 3.0), Rgb(0, 0, 0), 1.0);
        assert_eq!(at(&c, 2, 3), [128, 128, 128]);
        assert_eq!(at(&c, 3, 3), [0, 0, 0]);
    }

    #[test]
    fn a_ring_leaves_its_middle_and_reversed_outlines_still_fill() {
        let mut c = Canvas::new(20, 20, Rgb(255, 255, 255));
        c.fill(
            &Path::rounded_ring(4.0, 4.0, 12.0, 12.0, 2.0, 2.0),
            Rgb(0, 0, 0),
            1.0,
        );
        assert_eq!(at(&c, 10, 10), [255, 255, 255]);
        assert_eq!(at(&c, 10, 3), [0, 0, 0]);
        let mut backwards = Canvas::new(10, 10, Rgb(255, 255, 255));
        backwards.fill(
            &Path::polygon(&[p(2.0, 2.0), p(2.0, 6.0), p(6.0, 6.0), p(6.0, 2.0)]),
            Rgb(0, 0, 0),
            1.0,
        );
        assert_eq!(at(&backwards, 3, 3), [0, 0, 0]);
    }

    #[test]
    fn shapes_off_the_canvas_or_not_finite_draw_nothing_and_never_panic() {
        let mut c = Canvas::new(8, 8, Rgb(255, 255, 255));
        let before = c.pixels.clone();
        c.fill(&Path::rect(-100.0, -100.0, 50.0, 50.0), Rgb(0, 0, 0), 1.0);
        c.fill(&Path::rect(100.0, 100.0, 50.0, 50.0), Rgb(0, 0, 0), 1.0);
        c.fill(&Path::rect(f32::NAN, 0.0, 5.0, 5.0), Rgb(0, 0, 0), 1.0);
        c.fill(&Path::rect(0.0, 0.0, f32::INFINITY, 5.0), Rgb(0, 0, 0), 1.0);
        assert_eq!(c.pixels, before);
        // Partly on: only the part on the canvas.
        c.fill(&Path::rect(-4.0, -4.0, 6.0, 6.0), Rgb(0, 0, 0), 1.0);
        assert_eq!(at(&c, 1, 1), [0, 0, 0]);
        assert_eq!(at(&c, 2, 2), [255, 255, 255]);
    }

    #[test]
    fn dashes_alternate_along_the_top_edge() {
        let mut c = Canvas::new(80, 20, Rgb(255, 255, 255));
        c.fill(
            &dashed_rounded(2.0, 4.0, 70.0, 12.0, 0.0, 2.0),
            Rgb(0, 0, 0),
            1.0,
        );
        // On from x 2 to 12, off to 20, on to 30.
        assert_eq!(at(&c, 6, 4), [0, 0, 0]);
        assert_eq!(at(&c, 16, 4), [255, 255, 255]);
        assert_eq!(at(&c, 25, 4), [0, 0, 0]);
    }
}
