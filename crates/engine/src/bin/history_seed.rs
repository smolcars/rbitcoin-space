//! Gives a fresh data directory some mempool history, for the browser tests: the server records
//! its first minute only 60 to 120 s after it starts, so `web/scripts/e2e.sh` runs this first.
//! It stores minutes through `history::record`, the sampler's own writer, so the rows are exactly
//! what a running server stores. A binary, not an example: an example is built with the crate's
//! dev-dependencies, which would compile the engine a second time for every browser test run.
//!
//! `cargo run -p engine --bin history_seed -- <DATA_DIR>` writes `<DATA_DIR>/regtest.sqlite`:
//! the 20 minutes that end an hour ago, without the five in their middle. The minute `i` (0 the
//! oldest) holds `901 + i` transactions, so a test can tell each one apart and see the hole where
//! 909 to 913 would be.

use std::path::PathBuf;

use engine::history::{self, Flow, MINUTE, Point, Totals};
use engine::projected::{BANDS, Bands};
use engine::store::{Options, Store};

const MINUTES: u64 = 20;
/// The minutes left out, as `i`: the gap the browser test looks for.
const GAP: std::ops::Range<u64> = 8..13;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: history_seed <DATA_DIR>")?,
    );
    let store = Store::open(&dir, "regtest", Options::default())?;
    let now = history::unix_now();
    let first = (now / MINUTE - 60 - MINUTES) * MINUTE;
    for i in (0..MINUTES).filter(|i| !GAP.contains(i)) {
        let count = 901 + i;
        // 200 vB a transaction, all in one fee band (0.3 to 0.5 sat/vB, the fifth of 12): the
        // bands sum to `vsize`, as the sampler's do, and the lowest band's split is known (zero).
        let mut bands = [0; BANDS];
        bands[4] = count * 200;
        let sums = Totals {
            count,
            vsize: count * 200,
            fees: count * 400,
            min_fee: 1_000,
            bands: Bands::new(bands),
            flow: Flow {
                in_count: 3,
                in_vsize: 600,
                out_count: 2,
                out_vsize: 400,
                mined_count: 2,
                mined_vsize: 400,
            },
        };
        let time = first + i * MINUTE;
        history::record(
            &store,
            Point {
                time,
                samples: 1,
                sums,
            },
            time,
        )
        .await?;
    }
    Ok(())
}
