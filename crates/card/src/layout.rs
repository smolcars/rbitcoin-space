//! Card C laid out: sizes, colours and positions are the mock-up's (`cards.tsx`, `parts.tsx` and
//! `model.ts` of draft PR 222), in its 1200 by 630 coordinates, y down, text on its baseline.

use crate::format;
use crate::paint::{Canvas, Path, Rgb, dashed_rounded, p, stroke, stroke_curve};
use crate::text::{self, Weight};
use crate::{Block, Card, HEIGHT, Layers, Network, Strip, Subject, Tile, Tx, TxState, WIDTH};

/// The light theme on white: a card is a picture, so it has one theme, never the viewer's.
const BG: Rgb = Rgb(0xff, 0xff, 0xff);
const SURFACE: Rgb = Rgb(0xff, 0xff, 0xff);
const SUNKEN: Rgb = Rgb(0xee, 0xf1, 0xf3);
const LINE: Rgb = Rgb(0xe1, 0xe6, 0xe9);
const LINE_STRONG: Rgb = Rgb(0x7a, 0x86, 0x8d);
const TEXT: Rgb = Rgb(0x16, 0x1b, 0x1e);
const MUTED: Rgb = Rgb(0x56, 0x61, 0x6a);
const ACCENT: Rgb = Rgb(0xa8, 0x19, 0x6b);
const POSITIVE: Rgb = Rgb(0x1b, 0x6e, 0x43);
const CAUTION: Rgb = Rgb(0x8a, 0x5a, 0x00);

/// The fee ramp, band 1 to 12 (design/tokens.css): one set of values in both themes.
const FEE: [Rgb; 12] = [
    Rgb(0x86, 0x8a, 0x8d),
    Rgb(0x79, 0x87, 0x91),
    Rgb(0x6b, 0x84, 0x94),
    Rgb(0x69, 0x8a, 0xa0),
    Rgb(0x68, 0x8f, 0xac),
    Rgb(0x58, 0x85, 0xb7),
    Rgb(0x5c, 0x89, 0xc3),
    Rgb(0x5d, 0x86, 0xce),
    Rgb(0x61, 0x82, 0xd7),
    Rgb(0x68, 0x7c, 0xe0),
    Rgb(0x71, 0x76, 0xe7),
    Rgb(0x7b, 0x6f, 0xed),
];

fn fee_color(band: u8) -> Rgb {
    FEE.get(usize::from(band.clamp(1, 12)) - 1)
        .copied()
        .unwrap_or(FEE[0])
}

/// Text may run from the left margin to here.
const RIGHT: f32 = 1144.0;
/// The top of the strip's sunken band.
const BAND: f32 = 444.0;
const TILE_W: f32 = 128.0;
const TILE_H: f32 = 120.0;
const TILE_Y: f32 = 468.0;
const TILE_GAP: f32 = 16.0;
/// Inside a tile, the layers keep this far from its frame.
const INSET: f32 = 6.0;

/// Draws `card` and returns it as a PNG.
pub fn draw(card: &Card) -> Vec<u8> {
    let mut c = Canvas::new(WIDTH as usize, HEIGHT as usize, BG);
    let marker = match &card.subject {
        Subject::Tx(t) => {
            head(&mut c, card.network, "Transaction", &t.id.hex());
            tx(&mut c, t)
        }
        Subject::Block(b) => {
            head(&mut c, card.network, "Block", &b.id.hex());
            block(&mut c, b);
            None
        }
    };
    strip(&mut c, &card.strip, marker, card.network);
    crate::png::encode(WIDTH, HEIGHT, &c.pixels)
}

fn draw_text(c: &mut Canvas, s: &str, x: f32, y: f32, size: f32, w: Weight, color: Rgb) -> f32 {
    text::draw(c, s, x, y, size, w, color)
}

/// The logo, the site's name, the network, then what the card is about and its id.
fn head(c: &mut Canvas, network: Network, kind: &str, hex: &str) {
    logo(c, 52.0, 26.0, 56.0);
    draw_text(c, "rbitcoin.space", 122.0, 68.0, 32.0, Weight::Bold, TEXT);
    let name = network.name();
    let size = 28.0;
    let w = text::width(name, size);
    c.fill(
        &Path::circle(RIGHT - w - size * 0.5, 66.0 - size * 0.35, size * 0.22),
        TEXT,
        1.0,
    );
    draw_text(c, name, RIGHT - w, 66.0, size, Weight::Regular, MUTED);
    draw_text(c, kind, 56.0, 156.0, 34.0, Weight::Regular, MUTED);
    let x = 56.0 + text::width(&format!("{kind} "), 34.0) + 6.0;
    draw_text(
        c,
        &format::short_id(hex),
        x,
        156.0,
        34.0,
        Weight::Regular,
        TEXT,
    );
}

/// `design/logo.svg`, drawn from its own 64-unit outline at (`x`, `y`), `size` px square.
fn logo(c: &mut Canvas, x: f32, y: f32, size: f32) {
    let k = size / 64.0;
    let at = |u: f32, v: f32| (x + u * k, y + v * k);
    let rect = |u: f32, v: f32, w: f32, h: f32| {
        let (px, py) = at(u, v);
        Path::rounded(px, py, w * k, h * k, 1.6 * k)
    };
    c.fill(&rect(19.0, 18.0, 26.0, 5.5), TEXT, 1.0);
    c.fill(&rect(19.0, 11.0, 26.0, 5.5), TEXT, 0.6);
    c.fill(&rect(27.0, 4.0, 18.0, 5.5), ACCENT, 1.0);

    // Claws, eyes and body: each outline is a list of cubic curves after its start, and lines.
    enum Step {
        C(f32, f32, f32, f32, f32, f32),
        L(f32, f32),
    }
    use Step::{C, L};
    let outlines: [(f32, f32, &[Step]); 3] = [
        (
            9.5,
            31.0,
            &[
                C(3.0, 27.0, 3.0, 14.0, 10.5, 9.5),
                C(13.5, 7.8, 17.0, 8.0, 20.0, 9.5),
                L(14.0, 15.8),
                L(19.5, 20.5),
                C(18.0, 26.0, 14.5, 30.0, 9.5, 31.0),
            ],
        ),
        (
            54.5,
            31.0,
            &[
                C(61.0, 27.0, 61.0, 14.0, 53.5, 9.5),
                C(50.5, 7.8, 47.0, 8.0, 44.0, 9.5),
                L(50.0, 15.8),
                L(44.5, 20.5),
                C(46.0, 26.0, 49.5, 30.0, 54.5, 31.0),
            ],
        ),
        (
            17.0,
            43.0,
            &[
                C(17.0, 36.0, 23.0, 33.0, 32.0, 33.0),
                C(41.0, 33.0, 47.0, 36.0, 47.0, 43.0),
                C(47.0, 49.0, 41.0, 52.0, 32.0, 52.0),
                C(23.0, 52.0, 17.0, 49.0, 17.0, 43.0),
            ],
        ),
    ];
    for (sx, sy, steps) in outlines {
        let mut path = Path::default();
        let (px, py) = at(sx, sy);
        path.move_to(px, py);
        for s in steps {
            match *s {
                C(a, b, cc, d, e, f) => {
                    let (a, b) = at(a, b);
                    let (cc, d) = at(cc, d);
                    let (e, f) = at(e, f);
                    path.cubic_to(a, b, cc, d, e, f);
                }
                L(a, b) => {
                    let (a, b) = at(a, b);
                    path.line_to(a, b);
                }
            }
        }
        path.close();
        c.fill(&path, TEXT, 1.0);
    }
    for (u, v) in [(27.0, 28.6), (37.0, 28.6)] {
        let (px, py) = at(u, v);
        c.fill(&Path::circle(px, py, 2.3 * k), TEXT, 1.0);
    }

    // Arms, eye stalks and legs: round-capped strokes.
    let mut lines = Path::default();
    for (sx, sy, c1x, c1y, c2x, c2y, ex, ey) in [
        (20.0, 40.0, 13.0, 37.0, 10.0, 33.0, 10.0, 28.0),
        (44.0, 40.0, 51.0, 37.0, 54.0, 33.0, 54.0, 28.0),
    ] {
        let mut arm = Path::default();
        let (a, b) = at(sx, sy);
        arm.move_to(a, b);
        let (c1, d1) = at(c1x, c1y);
        let (c2, d2) = at(c2x, c2y);
        let (e, f) = at(ex, ey);
        arm.cubic_to(c1, d1, c2, d2, e, f);
        lines.add(stroke_curve(&arm, 3.2 * k), false);
    }
    let polyline = |pts: &[(f32, f32)], w: f32| {
        let pts: Vec<_> = pts
            .iter()
            .map(|&(u, v)| {
                let (a, b) = at(u, v);
                p(a, b)
            })
            .collect();
        stroke(&pts, w * k, true)
    };
    for pts in [[(28.0, 35.0), (27.0, 30.0)], [(36.0, 35.0), (37.0, 30.0)]] {
        lines.add(polyline(&pts, 2.4), false);
    }
    for pts in [
        [(20.0, 45.0), (12.0, 47.0), (8.0, 53.0)],
        [(22.0, 49.0), (15.0, 53.0), (13.0, 59.0)],
        [(26.0, 51.0), (22.0, 57.0), (22.0, 61.0)],
        [(44.0, 45.0), (52.0, 47.0), (56.0, 53.0)],
        [(42.0, 49.0), (49.0, 53.0), (51.0, 59.0)],
        [(38.0, 51.0), (42.0, 57.0), (42.0, 61.0)],
    ] {
        lines.add(polyline(&pts, 3.0), false);
    }
    c.fill(&lines, TEXT, 1.0);
}

/// A figure's value: the number, its dimmed trailing zeros, then its unit smaller and muted.
#[allow(clippy::too_many_arguments)]
fn value(
    c: &mut Canvas,
    x: f32,
    y: f32,
    size: f32,
    unit_size: f32,
    value: &str,
    zeros: &str,
    unit: Option<&str>,
) -> f32 {
    let mut end = draw_text(c, value, x, y, size, Weight::Bold, TEXT);
    end = draw_text(c, zeros, end, y, size, Weight::Bold, MUTED);
    if let Some(u) = unit {
        end = draw_text(
            c,
            &format!(" {u}"),
            end,
            y,
            unit_size,
            Weight::Regular,
            MUTED,
        );
    }
    end
}

fn value_width(size: f32, unit_size: f32, value: &str, unit: Option<&str>) -> f32 {
    text::width(value, size) + unit.map_or(0.0, |u| text::width(&format!(" {u}"), unit_size))
}

/// The big figure's sizes, and how much it shrinks so it ends by [`RIGHT`] when `beside` px
/// more must follow it on the line. Never grows.
const BIG: f32 = 120.0;
const BIG_UNIT: f32 = 48.0;

fn fit(natural: f32, room: f32) -> f32 {
    if natural > room && natural > 0.0 {
        room / natural
    } else {
        1.0
    }
}

enum Status {
    Confirmed,
    Unconfirmed,
}

struct Figure {
    label: &'static str,
    value: String,
    unit: Option<&'static str>,
    status: Option<Status>,
}

/// The row of smaller figures, each its value over its label, spaced by their widths. A row too
/// wide for the card is scaled down whole until it fits.
fn figures(c: &mut Canvas, items: &[Figure]) {
    let widths: Vec<f32> = items
        .iter()
        .map(|f| {
            let w = value_width(40.0, 28.0, &f.value, f.unit);
            let lw = text::width(f.label, 28.0) + if f.status.is_some() { 40.0 } else { 0.0 };
            w.max(lw)
        })
        .collect();
    let natural = widths.iter().sum::<f32>() + 56.0 * (widths.len().saturating_sub(1) as f32);
    let k = fit(natural, RIGHT - 56.0);
    let mut x = 56.0;
    for (f, w) in items.iter().zip(&widths) {
        value(c, x, 362.0, 40.0 * k, 28.0 * k, &f.value, "", f.unit);
        let (color, offset) = match f.status {
            Some(Status::Confirmed) => {
                check(c, x, 380.0, 26.0 * k, POSITIVE);
                (POSITIVE, 38.0 * k)
            }
            Some(Status::Unconfirmed) => {
                clock(c, x, 380.0, 28.0 * k, CAUTION);
                (CAUTION, 38.0 * k)
            }
            None => (MUTED, 0.0),
        };
        let weight = if f.status.is_some() {
            Weight::Bold
        } else {
            Weight::Regular
        };
        draw_text(c, f.label, x + offset, 404.0, 28.0 * k, weight, color);
        x += (w + 56.0) * k;
    }
}

/// A tick: confirmed.
fn check(c: &mut Canvas, x: f32, y: f32, s: f32, color: Rgb) {
    let pts = [
        p(x, y + s * 0.55),
        p(x + s * 0.38, y + s * 0.9),
        p(x + s, y + s * 0.15),
    ];
    c.fill(&stroke(&pts, s * 0.16, true), color, 1.0);
}

/// A clock: waiting.
fn clock(c: &mut Canvas, x: f32, y: f32, s: f32, color: Rgb) {
    let r = s / 2.0;
    let (cx, cy) = (x + r, y + r);
    let w = s * 0.13;
    let mut path = Path::ring(cx, cy, r - s * 0.07, w);
    path.add(
        stroke(
            &[
                p(cx, cy - r * 0.5),
                p(cx, cy),
                p(cx + r * 0.38, cy + r * 0.28),
            ],
            w,
            true,
        ),
        false,
    );
    c.fill(&path, color, 1.0);
}

/// The amount large, then fee rate, fee, size and status; returns the fee band for the marker.
fn tx(c: &mut Canvas, t: &Tx) -> Option<u8> {
    let (whole, zeros) = format::exact_btc(t.amount);
    let natural = value_width(BIG, BIG_UNIT, &format!("{whole}{zeros}"), Some("BTC"));
    let k = fit(natural, RIGHT - 52.0);
    value(
        c,
        52.0,
        282.0,
        BIG * k,
        BIG_UNIT * k,
        &whole,
        &zeros,
        Some("BTC"),
    );

    let vsize = format::vsize(t.weight);
    let rate = format::fee_rate(t.fee, vsize).unwrap_or_else(|| format::MISSING.into());
    let band = format::band(&rate);
    let (size, size_unit) = format::size(vsize);
    let status = match t.state {
        TxState::Confirmed { time } => Figure {
            label: "Confirmed",
            value: format::day(time),
            unit: None,
            status: Some(Status::Confirmed),
        },
        TxState::Unconfirmed { drawn } => Figure {
            label: "Unconfirmed",
            value: format::clock(drawn),
            unit: None,
            status: Some(Status::Unconfirmed),
        },
    };
    figures(
        c,
        &[
            Figure {
                label: "Fee rate",
                value: rate,
                unit: Some("sat/vB"),
                status: None,
            },
            Figure {
                label: "Fee",
                value: format::group(t.fee),
                unit: Some("sats"),
                status: None,
            },
            Figure {
                label: "Size",
                value: size,
                unit: Some(size_unit),
                status: None,
            },
            status,
        ],
    );
    Some(band)
}

/// The height large with its time beside it, then miner, transactions, median fee and fees.
fn block(c: &mut Canvas, b: &Block) {
    let height = format::group(u64::from(b.height));
    let date = format!("{}, {}", format::day(b.time), format::clock(b.time));
    let date_w = text::width(&date, 34.0);
    let k = fit(text::width(&height, BIG), RIGHT - 56.0 - 40.0 - date_w);
    value(c, 52.0, 282.0, BIG * k, BIG_UNIT * k, &height, "", None);
    let x = 56.0 + text::width(&height, BIG * k) + 40.0;
    draw_text(c, &date, x, 280.0, 34.0, Weight::Regular, MUTED);
    figures(
        c,
        &[
            Figure {
                label: "Miner",
                value: b.miner.to_owned(),
                unit: None,
                status: None,
            },
            Figure {
                label: "Transactions",
                value: format::group(u64::from(b.tx_count)),
                unit: None,
                status: None,
            },
            Figure {
                label: "Median fee",
                value: b
                    .median
                    .map_or_else(|| format::MISSING.into(), format::rate),
                unit: Some("sat/vB"),
                status: None,
            },
            Figure {
                label: "Fees",
                value: format::short_btc(b.fees),
                unit: Some("BTC"),
                status: None,
            },
        ],
    );
}

/// Where the layers of a block sit in a box `h` px tall, bottom up, as `layers` in the mock:
/// (band, y from the floor, height), whole pixels so neighbours meet without a seam, and every
/// band paid at least 2 px.
fn layers(l: &Layers, h: f32) -> Vec<(u8, f32, f32)> {
    let total: f64 = l.bands.iter().map(|&v| v as f64).sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let top = f64::from(l.fill.min(1.0)) * f64::from(h);
    let mut out = Vec::new();
    let mut y = 0.0f64;
    for (band, &v) in (1u8..).zip(&l.bands) {
        if v == 0 {
            continue;
        }
        let next = (y + (v as f64 / total * top).max(2.0)).round();
        out.push((band, y as f32, (next - y) as f32));
        y = next;
    }
    out
}

/// The strip's tiles' left edges, and where the tip's line goes: projected tiles from the left
/// margin, then 8 px more before the first mined one, the line in that gap.
fn tile_xs(s: &Strip) -> (Vec<f32>, Option<f32>) {
    let mut xs = Vec::with_capacity(s.tiles.len());
    let mut line = None;
    let mut x = 56.0;
    let mut previous_projected = false;
    for (i, t) in s.tiles.iter().enumerate() {
        let mined = matches!(t, Tile::Mined { .. });
        if mined && (previous_projected || i == 0) && line.is_none() {
            if previous_projected {
                x += 8.0;
            }
            line = s.now.then_some(x - 12.0);
        }
        previous_projected = !mined;
        xs.push(x);
        x += TILE_W + TILE_GAP;
    }
    (xs, line)
}

/// When a projected block is expected, as the home page's tiles say it. Regtest has no block
/// interval, so its tiles are counted instead.
fn projected_label(slot: u8, network: Network) -> String {
    const ORDINALS: [&str; 8] = [
        "Next", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth",
    ];
    if network == Network::Regtest {
        return ORDINALS
            .get(usize::from(slot))
            .copied()
            .unwrap_or("Later")
            .to_owned();
    }
    format!("~{} min", (u32::from(slot) + 1) * 10)
}

/// The sunken band, its tiles, the tip's line, the ring and the transaction's marker.
fn strip(c: &mut Canvas, s: &Strip, marker: Option<u8>, network: Network) {
    c.fill(
        &Path::rect(0.0, BAND, WIDTH as f32, HEIGHT as f32 - BAND),
        SUNKEN,
        1.0,
    );
    c.fill(&Path::rect(0.0, BAND - 1.0, WIDTH as f32, 2.0), LINE, 1.0);
    let (xs, line) = tile_xs(s);
    let inner = TILE_H - INSET * 2.0;
    for (i, (t, &x)) in s.tiles.iter().zip(&xs).enumerate() {
        if x >= WIDTH as f32 {
            break;
        }
        let focus = s.ring == Some(i);
        let (mined, layers_of, label) = match *t {
            Tile::Projected { slot, layers } => (false, layers, projected_label(slot, network)),
            Tile::Mined { height, layers } => (true, layers, format::group(u64::from(height))),
        };
        if mined {
            c.fill(&Path::rounded(x, TILE_Y, TILE_W, TILE_H, 6.0), SURFACE, 1.0);
        }
        if let Some(l) = &layers_of {
            for (band, ly, lh) in layers(l, inner) {
                let top = (TILE_Y + INSET + inner - ly - lh).max(TILE_Y + INSET);
                let bottom = TILE_Y + INSET + inner - ly;
                if bottom > top {
                    c.fill(
                        &Path::rect(x + INSET, top, TILE_W - INSET * 2.0, bottom - top),
                        fee_color(band),
                        1.0,
                    );
                }
            }
        }
        let color = if focus {
            ACCENT
        } else if mined {
            LINE
        } else {
            LINE_STRONG
        };
        let width = if focus { 4.0 } else { 2.0 };
        let frame = if mined {
            Path::rounded_ring(x, TILE_Y, TILE_W, TILE_H, 6.0, width)
        } else {
            dashed_rounded(x, TILE_Y, TILE_W, TILE_H, 6.0, width)
        };
        c.fill(&frame, color, 1.0);
        let (size, weight, color) = if focus {
            (28.0, Weight::Bold, TEXT)
        } else {
            (28.0, Weight::Regular, MUTED)
        };
        // A label wider than its tile and gap is set smaller, never cut.
        let size = size * fit(text::width(&label, size), TILE_W + TILE_GAP - 4.0);
        draw_text(c, &label, x, 620.0, size, weight, color);
    }
    if let Some(lx) = line {
        c.fill(
            &Path::rect(lx + 4.0 - 1.5, TILE_Y - 12.0, 3.0, TILE_H + 24.0),
            TEXT,
            1.0,
        );
    }
    if let (true, Some(band), Some(i)) = (s.marker, marker, s.ring)
        && let (Some(t), Some(&x)) = (s.tiles.get(i), xs.get(i))
    {
        let l = match *t {
            Tile::Projected { layers, .. } | Tile::Mined { layers, .. } => layers,
        };
        let middle = l
            .and_then(|l| {
                layers(&l, inner)
                    .into_iter()
                    .find(|(b, _, _)| *b == band)
                    .map(|(_, ly, lh)| INSET + inner - ly - lh / 2.0)
            })
            .unwrap_or(INSET);
        let (cx, cy) = (x + 30.0, (TILE_Y + 22.0).max(TILE_Y + middle));
        let s = 22.0;
        let h = s / 2.0;
        c.fill(
            &Path::rounded(cx - h - 5.0, cy - h - 5.0, s + 10.0, s + 10.0, 5.0),
            ACCENT,
            1.0,
        );
        c.fill(
            &Path::rounded(cx - h - 2.0, cy - h - 2.0, s + 4.0, s + 4.0, 3.0),
            SURFACE,
            1.0,
        );
        c.fill(
            &Path::rounded(cx - h, cy - h, s, s, 2.0),
            fee_color(band),
            1.0,
        );
    }
}
