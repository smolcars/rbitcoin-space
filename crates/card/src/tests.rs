//! Every state a card can be in, drawn and compared pixel by pixel with the pictures under
//! `fixtures/cards/`. The figures are the mock-ups' recorded sample (mainnet, block 976 200).
//!
//! After a deliberate change to the drawing, write the pictures again and look at each:
//!
//!     CARD_FIXTURES=write cargo test -p card

use std::path::PathBuf;

use crate::*;

fn id(hex: &str) -> Id {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
    }
    Id(out)
}

/// The mock-ups' mined blocks, newest first: height, bands, weight.
const MINED: [(u32, [u64; 12], u64); 6] = [
    (
        976_200,
        [
            0, 0, 278, 0, 0, 2406, 336_919, 40_878, 404_974, 149_336, 55_128, 9522,
        ],
        3_993_766,
    ),
    (
        976_199,
        [
            479, 0, 278, 0, 0, 1033, 711_316, 28_093, 137_202, 94_384, 18_406, 7577,
        ],
        3_991_840,
    ),
    (
        976_198,
        [
            0, 0, 278, 0, 0, 1194, 373_031, 89_752, 306_358, 183_586, 36_958, 8119,
        ],
        3_991_867,
    ),
    (
        976_197,
        [
            363, 0, 278, 0, 0, 454, 36_354, 114_901, 486_037, 273_371, 50_432, 37_527,
        ],
        3_991_877,
    ),
    (
        976_196,
        [
            0, 0, 278, 0, 0, 2899, 36_853, 1563, 450_443, 380_567, 105_667, 21_592,
        ],
        3_993_747,
    ),
    (
        976_195,
        [
            630, 0, 0, 0, 0, 1032, 349_538, 90_198, 534_707, 13_690, 4190, 5149,
        ],
        3_991_816,
    ),
];

/// The first three projected blocks: bands and virtual size.
const PROJECTED: [([u64; 12], u64); 3] = [
    (
        [
            0, 0, 0, 0, 0, 0, 0, 64_080, 575_746, 296_145, 50_041, 13_273,
        ],
        999_285,
    ),
    (
        [
            0, 40_415, 16_445, 12_551, 14_378, 217_669, 675_396, 22_281, 0, 0, 0, 0,
        ],
        999_135,
    ),
    ([0, 999_673, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 999_673),
];

fn mined(i: usize) -> Tile {
    mined_at(MINED[i].0, i)
}

/// A mined tile at `height` with the `i`th recorded block's layers.
fn mined_at(height: u32, i: usize) -> Tile {
    let (_, bands, weight) = MINED[i % MINED.len()];
    Tile::Mined {
        height,
        layers: Some(Layers::new(&bands, weight as f64 / 4e6)),
    }
}

fn projected(slot: u8, i: usize) -> Tile {
    let (bands, vsize) = PROJECTED[i];
    Tile::Projected {
        slot,
        layers: Some(Layers::new(&bands, vsize as f64 / 1e6)),
    }
}

/// The home page's strip at the tip: three projected blocks, the tip's line, five mined.
fn at_tip(ring: Option<usize>, marker: bool) -> Strip {
    Strip {
        tiles: vec![
            projected(0, 0),
            projected(1, 1),
            projected(2, 2),
            mined(0),
            mined(1),
            mined(2),
            mined(3),
            mined(4),
        ],
        now: true,
        ring,
        marker,
    }
}

fn confirmed() -> Tx {
    Tx {
        id: id("4a705c0b4a53b3b9991663d5adae4959d67841d12b9a1ef3666934518c42e459"),
        amount: 52_121_959 + 3_103_951,
        fee: 28_200,
        weight: 562,
        state: TxState::Confirmed {
            time: 1_794_875_390,
        },
    }
}

fn unconfirmed() -> Tx {
    Tx {
        id: id("a40ca583d81960fb79db8e2efb7a186ed1404f5d282fe8ac1a51c884e22a0194"),
        amount: 166_400 + 86_156_054,
        fee: 423,
        weight: 561,
        state: TxState::Unconfirmed {
            drawn: 1_794_876_861,
        },
    }
}

fn block() -> Block {
    Block {
        id: id("00000000000000000001241ca13d41915e64b9dc6e5059d7b6fc7ad193c9cb61"),
        height: 976_200,
        time: 1_794_875_390,
        miner: "MARA Pool",
        tx_count: 2108,
        median: Some(2.0112),
        fees: 2_650_903,
    }
}

fn card(subject: Subject, strip: Strip) -> Card {
    Card {
        network: Network::Mainnet,
        subject,
        strip,
    }
}

/// Every state, by fixture name.
fn states() -> Vec<(&'static str, Card)> {
    let buried = Strip {
        // Its three newer neighbours, it, and four older; no projected blocks, no tip line.
        tiles: (0..8).map(|i| mined_at(976_203 - i as u32, i)).collect(),
        now: false,
        ring: Some(3),
        marker: false,
    };
    let engine_off = Strip {
        // The eight newest blocks after the tip's line.
        tiles: (0..8).map(|i| mined_at(976_200 - i as u32, i)).collect(),
        now: true,
        ring: None,
        marker: false,
    };
    let mut beyond = at_tip(Some(2), true);
    beyond.tiles[2] = projected(5, 2);
    let huge = Tx {
        id: id("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        amount: u64::MAX,
        fee: u64::MAX,
        weight: u64::MAX,
        state: TxState::Confirmed { time: u64::MAX },
    };
    let nothing = Tx {
        id: id("0000000000000000000000000000000000000000000000000000000000000000"),
        amount: 0,
        fee: 0,
        weight: 0,
        state: TxState::Unconfirmed { drawn: 0 },
    };
    let huge_block = Block {
        id: id("0000000000000000000000000000000000000000000000000000000000000001"),
        height: u32::MAX,
        time: u64::from(u32::MAX),
        miner: "Carbon Negative (unidentified)",
        tx_count: u32::MAX,
        median: Some(f64::MAX),
        fees: u64::MAX,
    };
    let empty_block = Block {
        id: id("0000000000000000000000000000000000000000000000000000000000000002"),
        height: 0,
        time: 0,
        miner: "⛏️ Sv2 plebhash ⚡",
        tx_count: 1,
        median: None,
        fees: 0,
    };
    let huge_strip = Strip {
        tiles: vec![
            Tile::Mined {
                height: u32::MAX,
                layers: Some(Layers::new(&[u64::MAX; 12], f64::INFINITY)),
            },
            Tile::Mined {
                height: u32::MAX - 1,
                layers: Some(Layers::new(&[1; 12], 1.0)),
            },
            Tile::Mined {
                height: u32::MAX - 2,
                layers: Some(Layers::new(&[0; 10], 0.5)),
            },
            Tile::Mined {
                height: u32::MAX - 3,
                layers: None,
            },
        ],
        now: true,
        ring: Some(0),
        marker: false,
    };
    vec![
        ("tx", card(Subject::Tx(confirmed()), at_tip(Some(3), true))),
        (
            "tx-unconfirmed",
            card(Subject::Tx(unconfirmed()), at_tip(Some(0), true)),
        ),
        (
            "block",
            card(Subject::Block(block()), at_tip(Some(3), false)),
        ),
        ("block-buried", card(Subject::Block(block()), buried)),
        (
            "tx-unconfirmed-engine-off",
            card(Subject::Tx(unconfirmed()), engine_off),
        ),
        (
            "tx-unconfirmed-beyond",
            card(Subject::Tx(unconfirmed()), beyond),
        ),
        ("tx-huge", card(Subject::Tx(huge), huge_strip.clone())),
        ("tx-nothing", card(Subject::Tx(nothing), Strip::default())),
        ("block-huge", card(Subject::Block(huge_block), huge_strip)),
        (
            "block-empty",
            Card {
                network: Network::Regtest,
                subject: Subject::Block(empty_block),
                strip: Strip {
                    tiles: vec![
                        Tile::Projected {
                            slot: 0,
                            layers: None,
                        },
                        Tile::Projected {
                            slot: 1,
                            layers: None,
                        },
                        Tile::Projected {
                            slot: 2,
                            layers: None,
                        },
                        Tile::Mined {
                            height: 0,
                            layers: None,
                        },
                    ],
                    now: true,
                    ring: Some(3),
                    marker: false,
                },
            },
        ),
    ]
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cards")
}

fn pixels(png: &[u8]) -> Vec<u8> {
    let (w, h, px) = crate::png::decode(png).unwrap();
    assert_eq!((w, h), (WIDTH, HEIGHT));
    px
}

#[test]
fn every_state_draws_as_its_fixture() {
    let write = std::env::var("CARD_FIXTURES").as_deref() == Ok("write");
    for (name, card) in states() {
        let png = draw(&card);
        let path = fixtures().join(format!("{name}.png"));
        if write {
            std::fs::create_dir_all(fixtures()).unwrap();
            std::fs::write(&path, &png).unwrap();
            continue;
        }
        let want = pixels(&std::fs::read(&path).unwrap());
        let got = pixels(&png);
        // Pixels, not bytes, so another compressor version cannot fail it; a channel may differ
        // by a step or two of rounding across platforms' float units.
        let off = got
            .iter()
            .zip(&want)
            .filter(|(a, b)| a.abs_diff(**b) > 2)
            .count();
        assert_eq!(
            off,
            0,
            "{name}: {off} channels differ from {}",
            path.display()
        );
    }
}

#[test]
fn the_same_card_gives_the_same_bytes_and_a_small_png() {
    for (name, card) in states() {
        let png = draw(&card);
        assert_eq!(png, draw(&card), "{name}");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            &png[16..24],
            &[0, 0, 4, 176, 0, 0, 2, 118],
            "{name}: 1200 by 630"
        );
        assert!(png.len() < 100 * 1024, "{name}: {} bytes", png.len());
    }
}

/// Whatever the figures, nothing is drawn past the right margin above the strip: the big figure
/// and the row under it shrink to fit.
#[test]
fn every_figure_fits_inside_the_margin() {
    for (name, card) in states() {
        let px = pixels(&draw(&card));
        let width = WIDTH as usize;
        for y in 100..440 {
            for x in 1150..width {
                let i = (y * width + x) * 3;
                assert_eq!(&px[i..i + 3], &[255, 255, 255], "{name}: ink at ({x}, {y})");
            }
        }
    }
}

/// Every word a card writes, and every character its numbers can hold.
const WORDS: &[&str] = &[
    "rbitcoin.space",
    "Mainnet",
    "Signet",
    "Testnet4",
    "Testnet5",
    "Regtest",
    "Transaction ",
    "Block ",
    "0123456789abcdef…",
    " BTC",
    " sat/vB",
    " sats",
    " vB kvB MvB",
    "Fee rate",
    "Fee",
    "Size",
    "Confirmed",
    "Unconfirmed",
    "Miner",
    "Transactions",
    "Median fee",
    "Fees",
    "0123456789.,: \u{202f}–~",
    "UTC min Next Second Third Fourth Fifth Sixth Seventh Eighth Later",
    "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
];

#[test]
fn every_string_a_card_can_show_has_its_glyphs() {
    for word in WORDS {
        assert_eq!(text::missing(word), Vec::<char>::new(), "{word}");
    }
    for pool in engine::mining::pools::list().all() {
        assert_eq!(
            text::missing(&pool.name),
            Vec::<char>::new(),
            "pool {:?}: add the characters to design/fonts/card-subset.py",
            pool.name
        );
    }
}

#[test]
fn ten_bands_widen_to_twelve_with_the_lowest_kept_whole() {
    let l = Layers::new(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5);
    assert_eq!(l.bands, [1, 0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert_eq!(Layers::new(&[7; 12], 2.0).fill, 1.0);
    assert_eq!(Layers::new(&[7; 12], f64::NAN).fill, 0.0);
    assert_eq!(Layers::new(&[7; 3], -1.0).bands[2], 7);
}
