//! Link preview cards: a transaction's or a block's figures drawn as a 1200 by 630 PNG, for the
//! picture a chat app shows under a pasted link (docs/FRONTEND.md, "Link previews").
//!
//! [`draw`] takes a [`Card`], a typed value of numbers, ids and names from the server's own
//! lists, and returns the PNG. No I/O, no clock, no node: the same card always gives the same
//! bytes. The design is direction C of the mock-ups: the main figure as large as the card
//! allows, a row of smaller figures under it, and the home page's block strip at the bottom
//! with the subject's block ringed.
//!
//! Nothing here can show text from a transaction or a coinbase: every string drawn is written
//! from a number, an id's hex digits, a fixed word, or a pool name that is `&'static`, which only
//! the shipped pool list provides.

mod format;
mod layout;
mod paint;
mod png;
mod text;

pub use layout::draw;

/// The picture's size, in pixels.
pub const WIDTH: u32 = 1200;
pub const HEIGHT: u32 = 630;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Signet,
    Testnet4,
    Testnet5,
    Regtest,
}

impl Network {
    /// As the site's network switch names it.
    fn name(self) -> &'static str {
        match self {
            Self::Mainnet => "Mainnet",
            Self::Signet => "Signet",
            Self::Testnet4 => "Testnet4",
            Self::Testnet5 => "Testnet5",
            Self::Regtest => "Regtest",
        }
    }
}

/// A transaction id or block hash, its bytes in the order it is written in hex.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Id(pub [u8; 32]);

impl Id {
    fn hex(&self) -> String {
        use std::fmt::Write as _;
        self.0.iter().fold(String::with_capacity(64), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
    }
}

/// Everything one card shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub network: Network,
    pub subject: Subject,
    pub strip: Strip,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Subject {
    Tx(Tx),
    Block(Block),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tx {
    pub id: Id,
    /// Its outputs summed, in sats.
    pub amount: u64,
    pub fee: u64,
    pub weight: u64,
    pub state: TxState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxState {
    /// Its block's time, Unix seconds.
    Confirmed { time: u64 },
    /// When the card was drawn, Unix seconds: a chat app keeps a picture for days, so an
    /// unconfirmed card says when it was true.
    Unconfirmed { drawn: u64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub id: Id,
    pub height: u32,
    /// Header time, Unix seconds.
    pub time: u64,
    /// A name from the shipped pool list, or its "Unknown".
    pub miner: &'static str,
    /// Every transaction, the coinbase included.
    pub tx_count: u32,
    /// Median fee rate in sat/vB; `None` before the block's rates are known.
    pub median: Option<f64>,
    /// Sats.
    pub fees: u64,
}

/// The block strip along the bottom, left to right: projected blocks, then mined blocks newest
/// first, as the home page lays them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Strip {
    pub tiles: Vec<Tile>,
    /// Draws the tip's line before the first mined tile: the chain's newest block is there.
    pub now: bool,
    /// The tile ringed in the accent: the subject's block.
    pub ring: Option<usize>,
    /// Puts the transaction's marker, in its fee colour, in the ringed tile.
    pub marker: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tile {
    /// A block the mempool would fill, `slot` 0 for the next one.
    Projected {
        slot: u8,
        layers: Option<Layers>,
    },
    Mined {
        height: u32,
        layers: Option<Layers>,
    },
}

/// A block's fee bands as settled layers: virtual size per band, cheapest first, and how full
/// the block is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layers {
    bands: [u64; 12],
    fill: f32,
}

impl Layers {
    /// From the server's 12 bands, or the 10 of a block stored before the lowest was split
    /// (its first then stays whole, in the first slot, as `widenBands` does); `fill` is the
    /// share of the block's capacity used, 0 to 1.
    pub fn new(bands: &[u64], fill: f64) -> Self {
        let mut out = [0u64; 12];
        if bands.len() == 10 {
            for (slot, v) in out
                .iter_mut()
                .enumerate()
                .filter(|(i, _)| !matches!(i, 1 | 2))
                .map(|(_, s)| s)
                .zip(bands)
            {
                *slot = *v;
            }
        } else {
            for (slot, v) in out.iter_mut().zip(bands) {
                *slot = *v;
            }
        }
        let fill = if fill.is_finite() {
            fill.clamp(0.0, 1.0) as f32
        } else {
            0.0
        };
        Self { bands: out, fill }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests;
