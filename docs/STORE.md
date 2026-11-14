# Store

One SQLite file per network, `<DATA_DIR>/<network>.sqlite`, for the little data the node does not keep: per-block mining summaries, mempool history, block audits, Lightning graph history, prices. rbitcoin stays the source of truth for blocks, transactions, addresses and spends ([`ARCHITECTURE.md`](ARCHITECTURE.md#storage)). The code is `crates/engine/src/store/`.

## Rules

1. **Store only what we derive or observe.** Never a copy of something the node can answer.
2. **One writer.** Every write goes through `Store::write` to the single writer thread. Nothing else holds a read-write connection. The store owns each write's transaction: `BEGIN`, `COMMIT`, `ROLLBACK` and savepoint statements in a write are refused by an authorizer, and a commit hook turns any other commit from inside it (an autocommit after `INSERT OR ROLLBACK` ended the transaction) into a rollback. The write then fails and leaves nothing behind. Before a write that changed `blocks` commits, the store brings the block table's [totals](#totals) up to date in the same transaction.
3. **Readers cannot write.** `Store::read` runs on read-only connections that also have `query_only` set.
4. **SQL is a `&'static str`.** `Sql::prepare` takes only a string literal (or `concat!` of literals), so a query cannot be built from request data with `format!`. Values are bound as parameters with `params![…]` ([`SECURITY.md`](SECURITY.md) rule 12). A variable-length list is one parameter: a JSON array read with `json_each(?1)`, not a generated `IN (?, ?, …)`.
5. **A shipped migration never changes.** Fix it with a new one.
6. **The engine does not log** ([`LOGGING.md`](LOGGING.md) rule 6). It returns errors and calls `Options::observer` with an `Event`; the server turns those into log events.

## Using it

```rust
let store = Store::open(&data_dir, "mainnet", Options::default())?; // blocking: at startup

// A write is one transaction. It resolves once committed and on disk; Err or a panic rolls back.
store.write(move |sql| {
    let mut insert = sql.prepare("INSERT INTO blocks (height, fees) VALUES (?1, ?2)")?;
    for b in &blocks {
        insert.execute(params![b.height, b.fees])?;
    }
    Ok(())
}).await?;

// A read runs on tokio's blocking pool and is interrupted past Options::read_time_limit.
// `Read` names it in the timeout event.
let fees: Option<i64> = store.read(Read::Blocks, move |sql| {
    Ok(sql.prepare("SELECT fees FROM blocks WHERE height = ?1")?
        .query_row(params![height], |r| r.get(0))
        .optional()?)
}).await?;
```

- **Batch writes.** One `write` per row pays one commit, and one fsync, per row. Put thousands of rows in one call: a backfill inserts in batches of about 10,000. Keep a single write under a second or so, because every other write waits behind it; a longer one is reported as `Event::SlowWrite`.
- **Back-pressure.** `write` waits when `Options::queue` writes (64) are already waiting. `try_write` fails with `Error::Full` instead, for a producer that would rather drop a sample than fall behind. `queue_depth()` says how many are waiting.
- **Reads.** At most `Options::readers` (4) reads run at once; more wait for a free connection. Once a read has run for `read_time_limit` (2 s), its running statement and any later one are stopped, it returns `Error::TimedOut`, and `Event::ReadTimedOut` names it by the `Read` its caller gave (`store_read_timed_out`). The deadline is enforced on the blocking thread: SQLite's progress handler stops a long statement, and `Sql::prepare` refuses new ones, so it holds across statements and after the caller stops waiting. It bounds SQL, not Rust work inside the closure. It is wall-clock time, so a stalled machine trips it too: on 2026-11-12 a host at load 20 to 33 timed out a count that takes milliseconds. Do not call `Statement::reset_status` on SQLite's VM-step counter in a read: the progress handler counts on it. A read may use `BEGIN` for a consistent snapshot across statements; one left open is rolled back before the connection is reused. Reads see the last committed write, never one in progress, and never wait for the writer: measured on a 300,000-row table, a full scan took 35 ms (median) alone and 43 ms (at most 55 ms) while 10,000-row writes committed back to back, every third holding the writer for a second.
- **Versions.** `version(&[Table::Blocks, …])` is a number that changes whenever one of those tables changes, or `None` while a write to one of them is open: the writer's authorizer marks each table a statement will insert into, update or delete from when the statement is prepared, before it runs (whatever its form: a replace, a table without rowids, a whole-table delete, a trigger's writes or a foreign key's cascade; a trigger's table is marked even when it does not fire), and the writer clears the marks once the write has committed or rolled back, before `write` returns. A statement cannot outlive its write (`Sql::prepare` has no statement cache), so one run many times was marked when it was prepared and stays marked to the end. Each write that marks a table moves its number by one step, and nothing else moves it: the store's tests write through every path above, a migration and a rollback, and check exactly that. An answer computed after reading `Some(v)` is what a fresh read gives for as long as `version` returns `Some(v)`; the server keeps such answers in memory ([`API.md`](API.md#answers-kept-in-memory)). Only `blocks`, `audits` and `mempool_history` are followed; add a table to `Table` when an answer kept in memory reads it. A write from another process or connection is not seen, which the one-writer rule rules out.
- **The gate.** With `Options::genesis` set, as the server sets it, writes wait until the caller opens the gate, and stop whenever it closes it ([`chain`](#chain)). `try_write` waits for the gate too; it fails at once only on a full queue. Reads are never held. Without `genesis` (tests, tools) the gate is open from the start.
- **A queued write cannot be cancelled.** Dropping the future of a `write` that is already queued does not stop it; it still commits.
- **Failing writes are counted.** A write SQLite refuses (anything but a constraint, which is the caller's logic) is classified by its code, `disk_full`, `read_only`, `corrupt`, `busy`, `io` or `other` (`store::failure_kind`), and reported as `Event::WriteFailed` with SQLite's message at the 1st, 2nd, 4th… failure in a row, then `Event::WriteRecovered` at the next commit. `write_health()` says when a write last committed and how many have failed since, for `/readyz` ([`DEPLOY.md`](DEPLOY.md#health)). The writes themselves are each caller's to retry or drop. Tested with a full disk simulated by `max_page_count` (SQLite answers `SQLITE_FULL`, as for a full disk) and a read-only connection.
- **Failing reads are reported too.** A read SQLite refuses, or whose closure panics, is reported as `Event::ReadFailed` with its `Read`, the same classification (`panicked` for a panic) and SQLite's message at the 1st, 2nd, 4th… failure of that kind of read in a row, then `Event::ReadRecovered` at the next that works (`store_read_failed`, `store_read_recovered`). So a caller that drops a read's error (a page that falls back to the node, a background task that tries again later) still leaves a line: the 2026-11-14 deployment's Lightning index failed every 30 s for hours and said nothing. A timeout is `Event::ReadTimedOut` and is not counted here. Tested with a read of a missing table and a panicking read.
- **Errors stay inside.** A store error can contain SQL text. Never send it to a client ([`SECURITY.md`](SECURITY.md) rule 17): answer `500` and report it.
- **Closing.** `close().await` lets queued writes finish, then closes the file. Dropping the store does the same in the background.

## Adding a migration

1. Add `crates/engine/src/store/migrations/NNNN_short_name.sql`, numbered one past the last (`0001_blocks.sql`, `0002_…`). Lowercase letters, digits and underscores.
2. Run `cargo test -p engine store`. It fails and prints the line to append to `migrations/CHECKSUMS`. Append it.
3. That is all: `build.rs` compiles every `.sql` file in the directory into the binary, in name order.

What happens at open: each migration past the file's `user_version` runs in its own transaction together with the new `user_version`, so it applies exactly once, and a failure leaves the database at the version before it. Two processes opening the same file at once cannot both apply one, because the version is read under the write lock.

What fails loudly:

| Mistake | Where it fails |
|---|---|
| A gap (`0001`, `0003`), a duplicate number, or a bad name | `validate` in the tests, and `Store::open` refuses with `OpenError::BadMigrations` |
| A new file without its `CHECKSUMS` line | `shipped_migrations_are_numbered_and_unchanged` |
| An edited or deleted shipped migration | The same test: the checksum no longer matches. Changing an existing `CHECKSUMS` line in review means a shipped migration was edited |
| A database written by a newer build | `Store::open` refuses with `OpenError::TooNew` and leaves the schema alone |

Inside a migration: no `BEGIN` or `COMMIT` (it already runs in a transaction; they are refused and the open fails), and nothing that cannot run in one (`VACUUM`, `PRAGMA journal_mode`). SQLite's `ALTER TABLE` is limited; to reshape a table, create the new one, copy, drop and rename in the same migration.

## Tables

| Table | Migration | Holds | Rebuildable |
|---|---|---|---|
| [`blocks`](#blocks) | `0001_blocks.sql`, `0002_pools.sql` (the `pool` column), `0012_split_lowest_band.sql` (the [split](#fee-bands)) | One row per block on the best chain | Yes, by backfill |
| `pool_list` | `0002_pools.sql` | One row: the version of the pool list and rules the `pool` column was last fully computed with | Yes: a missing or other version redoes the column |
| [`audits`](#audits) | `0003_audits.sql` | One row per block we watched arrive: how it compared with the block we expected | **No:** observed live |
| [`mempool_history`](#mempool_history) | `0004_mempool_history.sql`, `0012_split_lowest_band.sql` (the [split](#fee-bands)) | The mempool sampled once a minute, rolled into hours and days as it ages | No: observed live, lost with the file |
| [`replacements`](#replacements) | `0005_replacements.sql`, `0008_replacement_blocks.sql` | The replacement record: what replaced what, as the mempool tracker saw it | No: observed live, lost with the file |
| [`ln_channels`](#ln_channels) | `0006_lightning.sql`, `0007_lightning_lookups.sql` (`open_txid` and the lookup indexes) | Every public channel the Lightning peer verified, with its close | **No:** gossip forgets a channel once it closes |
| [`ln_statistics`](#ln_statistics) | `0006_lightning.sql` | The Lightning network's totals every ten minutes, rolled into hours and days as they age | No: observed live |
| [`chain`](#chain) | `0009_chain.sql` | One row: the genesis hash of the chain the file was written for | Yes: written again by the check below |
| [`block_totals`, `pool_totals`](#totals) | `0010_block_totals.sql` | The block table's running totals: per day and per block series point, and per pool per 1,008 heights and per week | Yes: recomputed from `blocks` |
| `totals_dirty` | `0010_block_totals.sql` | The buckets a write has touched; always empty once it commits | Yes |
| `totals_pending` | `0010_block_totals.sql` | One row while rows from before the totals are still being totalled ([Filling](#filling-the-totals)) | Yes |
| [`fee_samples`, `fee_blocks`](#fee_samples-and-fee_blocks) | `0011_fee_score.sql` | What the fee recommendations served every 30 s, and every block's clearing rate: the score the server keeps of itself | No: observed live, lost with the file |
| [`ledger_*`](#ledger) | `0013_ledger.sql` | Running totals, newest transactions and a balance chart for a bounded set of very large addresses, kept from each block | Yes: each script is seeded again from the node |

### Fee bands

`blocks` and `mempool_history` hold virtual size in the design's 12 fee bands ([`DESIGN.md`](DESIGN.md#fee-scale)) as ten columns and a split. `band0` … `band9` are the ten bands the store first had: `band0` is everything under 0.2 sat/vB, then 0.2–0.3 up to 10 and over. `band0_12_15` and `band0_15_20` are the parts of `band0` in [0.12, 0.15) and [0.15, 0.2), so under 0.12 is `band0` minus both. A row stored before `0012_split_lowest_band.sql` has them `NULL`, and so does a sum of rows not all of which knew them; nothing guesses at a split that was not recorded, and `band0` always keeps its meaning.

**Served as 12 or 10.** Every route and topic that sends a stored row's bands (`fee_bands` of the block facts, `bands` of `/app/mempool/history`) sends 12 numbers, cheapest first, when the split is known, and the ten stored bands when it is not. A client reads the length: 10 means the lowest band is not split. `engine::projected::Bands` is that rule in code. Bands from the live projection (the `mempool` and `projected` topics) are always 12.

### Adding a table

Follow `blocks` (`crates/engine/src/blocks/`):

1. **The migration:** the table, its indexes and a comment on each column, as above. Prefer `STRICT`. Every column earns its place by a use that is planned; a later need gets a later migration.
2. **A module in `crates/engine/`** owning every statement on the table: static SQL in one file (`db.rs`), typed reads for the tasks that use it (`async fn` taking `&Store`, returning plain structs), and the writers. Nothing outside it writes SQL for the table.
3. **I/O through a trait** (`Source`) with a real implementation over the node clients and a mock in the tests, so the logic is tested without a node.
4. **Report, don't log:** the engine returns errors and calls an observer with typed events; the server turns them into log events (`crates/server/src/blocks.rs`).
5. **Say here** which of its data is rebuildable and which is lost with the file.

### chain

A file is named for a network, but nothing in a block row says which chain it came from, and a server whose `{NET}_*` variables point at another network's node would fill the file with that chain's data (found in the deployment rehearsal: `mainnet.sqlite` filled with regtest blocks). Two guards keep that from happening; neither ever deletes data.

**The file records its chain.** `chain` holds one row, the genesis block's hash (32 bytes, internal order). At open, with `Options::genesis` set:

| The file has | Open |
|---|---|
| A row naming this genesis | Opens |
| A row naming another | Refused, file untouched: `OpenError::WrongChain`, logged as `store_open_failed` with the file and the other genesis hash, and the network runs without a store |
| No row, no block rows (a new file) | Writes the row and opens |
| No row, but block rows: a file from before this table | Opens, *unstamped*: the server checks its rows against the node first (below) |

**Writes wait for the node** (`Store::set_gate`). The gate starts `Waiting`. The server's RPC check, at startup and every 30 s ([`DEPLOY.md`](DEPLOY.md#health)), sets it:

- The node answers for this network's chain: `Open`, after checking an unstamped file. Writes that waited commit.
- The node answers for another chain: `Held`. New writes wait. A hold moves the store's generation (`Store::generation`) when it begins and again when it ends, and a write commits only at the generation its data was read at: so when the gate opens again, every write that began before or during the hold fails with `Error::Held`, because it may carry what was read from the other chain; so does a write the writer reaches while it is held. A writer that keeps data in a queue of its own tags it with the generation when it reads it and writes it with `Store::write_from`: the replacement record drops batches made before or during a hold (`replacements_store_failed` with `held`), and the Lightning history drops the records pending or sent meanwhile (`lightning_history_failed` with `held`). The writers take their next data from the node as usual.
- The node is unreachable, or refuses the password: nothing changes. At startup, writes keep waiting, and the server serves what it can meanwhile; after the chain was confirmed, writes go on, since the chain was right when last seen.

What is not covered: data read in the up to 30 s between a node changing chain under the server and the next check is written, as is a read still in flight when the check finds the node right again. The block table replaces those rows as a reorg once the right chain is back; an audit, a mempool sample or a replacement from that window stays. The check reads the RPC endpoint's chain; Esplora and Electrum on another node than RPC are not checked.

**An unstamped file is checked against the node** at the first check that finds the right chain. The server reads two rows that lie at least 100 blocks below both the node's tip and the file's own highest row, so that no reorg can have moved them, either on the node or in what the old server last followed, the lowest and the highest, and asks the node for each (`getblockheader`: the same height, on the active chain):

| Result | Then |
|---|---|
| Both on the node's chain, or no block rows | The row is written and the gate opens |
| Either is not | `store_wrong_chain` with its height; the gate is `Refused` for as long as the process runs. Reads go on, so pages still show what the file holds; the file is untouched |
| No row that deep: a node far behind the file, or a file whose rows span fewer than 100 blocks | Writes wait; `store_chain_unverified` once, and each check tries again. A node catching up ends it; a file that small never gets a row deep enough, so move it aside |

Another chain's rows sit at one end of a file: another node's backfill writes from its tip down to the lowest row, and following its tip writes the highest. The two rows are a sample, not a proof: rows from another chain in the middle of a file filled by both are not found. Moving a refused file out of `DATA_DIR` and restarting starts an empty file, which the backfill fills again.

### blocks

One row per block on the best chain: what the mining dashboard and the history charts (fees, rewards, fee rates, sizes, block times, difficulty, pools) need for any period without asking the node about each block. The code is `crates/engine/src/blocks/`.

| Column | Type | Why |
|---|---|---|
| `height` | integer key | Position on the best chain; every range and page is by height |
| `hash` | 32-byte blob, unique | Lookups by hash (the block facts route) and the reorg check. The bitcoin crate's internal byte order, the reverse of the printed hash |
| `time` | integer, indexed | Header timestamp: per-day buckets, block intervals, and periods asked by time |
| `tx_count` | integer | Transactions per block and per period; the coinbase included |
| `size`, `weight` | integer | Block size charts and fullness |
| `paying_weight` | integer | The weight of every transaction but the coinbase, which the block facts route serves as `weight` |
| `fees`, `subsidy`, `reward` | integer, sats | Fee and reward charts. `reward` is the coinbase's outputs summed: what the miner took, which can be less than subsidy plus fees |
| `difficulty` | real | Difficulty and hashrate charts (hashrate ≈ difficulty × 2³² / interval) |
| `coinbase_tag` | blob, ≤ 100 bytes | The coinbase input's script, for pool attribution by tag. Consensus caps it at 100 bytes |
| `payouts` | blob | The coinbase's outputs paying more than zero, at most 8, each at most 128 bytes, as a length byte and the script: pool attribution by payout address. Longer scripts are no address and are left out |
| `rated` | integer, 0 or 1 | Completeness: 1 once the columns below are known |
| `fee_min` … `fee_max` | real, nullable | Size-weighted fee-rate percentiles in sat/vB, unrounded (min, p10, p25, median, p75, p90, max). Null until rated, and for a rated block that holds only its coinbase |
| `band0` … `band9` | integer, nullable | Virtual size paying in each of the ten stored [fee bands](#fee-bands), `band0` all under 0.2 sat/vB; they sum to the paying transactions' virtual size |
| `band0_12_15`, `band0_15_20` | integer, nullable | The parts of `band0` in [0.12, 0.15) and [0.15, 0.2) sat/vB. Written with every rating since `0010`; `NULL` for a block rated before it |
| `pool` | integer, indexed | Who mined the block, by the rules in [`API.md`](API.md#mining): the pool list's id, 0 for Unknown. Set when the row is written. The index gives a pool's blocks by height |

The coinbase tag and scripts are written by whoever mined the block. They are stored as bytes, bounded as above, and never turned into text here; a page renders them as text ([`SECURITY.md`](SECURITY.md) rule 14). Pool attribution reads them only as bytes to compare with the pool list.

**The pool column follows the list.** `blocks::reattribute` compares `pool_list.version` (a hash of the list file and a rules number) with the build's; when they differ, as on the first start after `0002_pools.sql` or with a new list, it recomputes every row's pool from its stored coinbase in writes of 10,000 rows, newest first, then records the version: 1.8 s for 975,000 rows, no node call. Rows written meanwhile already use the build's list, and a row replaced between the read and the write keeps its new pool (the update is keyed by height and hash). The mining routes wait for it.

**Completeness.** A row exists only once its totals and coinbase are known, so every row has everything above `rated`. `rated = 0` means the fee rates are still to come; a partial index on those rows lets the backfill find the next one at once. A height with no row is a block not yet backfilled.

**Size.** About 300 bytes a row with its indexes: 295 MB for a table filled to mainnet's 975,000 blocks.

**Rebuildable.** Everything here is derived from the node. Deleting the file loses nothing the backfill cannot redo.

#### Writers

| Writer | Heights | Does |
|---|---|---|
| `follow` | the newest 100 (`ZONE`) | On every new tip: reads Esplora's headers for the zone and compares each hash with the table. A row whose hash differs is stale; it is replaced, and every row above the tip is deleted, in one write. Below the zone it also checks the highest stored row, jumping any heights not stored yet (after downtime, say), and walks down while pages of ten headers hold stale rows, jumping gaps the same way, so a reorg of any depth is repaired in one call at one page more than its stale rows. It reads the tip again at the end and writes nothing if it moved, so every page comes from one chain. Missing rows in the zone are added; replacements are read 50 blocks a batch. The newest 10 get their fee rates from the summaries the server computes for every new block anyway, so a new block costs the node one `getblockstats` and a coinbase lookup more, nothing heavier |
| `backfill` | below the zone | Adds rows the table lacks and rates rows that lack fee rates, newest first. Never overwrites a row. Current rows must never land above stale ones, since `follow`'s walk stops at the first page that agrees and would never reach them. So the backfill starts only after `follow` has succeeded once; drops a batch read before any `follow` write that replaced rows; and before writing a batch checks the highest stored row below it against the node (by the batch's parent hash when adjacent, else one page of headers). A stale one is deleted instead, and the next steps check the rows under it the same way and refill the heights |

Fee rates are written with `UPDATE … WHERE height = ? AND hash = ?`, so rates computed for a block that has since left the chain never land on its replacement.

#### Backfill

Two tiers, one step of each in turn:

| Tier | Step | Node calls per step |
|---|---|---|
| Totals | one run of up to 50 consecutive missing heights, highest first, so the row checked below it is the only one beneath it | Esplora `/blocks/:height` (ten blocks each), one batched `getblockstats` asking only `totalfee`, `subsidy` and `total_weight`, Esplora `/block/:hash/txid/0` per block, one batched `getrawtransaction` for the coinbases |
| Rates | the highest unrated row within `BACKFILL_FEE_RATE_DEPTH` of the tip | One block listing ([`RBITCOIN.md`](RBITCOIN.md#listing-a-blocks-transactions)), through the same statistics code as the block facts route: Esplora's `/block/:hash/txs/summary`, `/block/:hash` and the coinbase's `/tx/:txid/raw` on a node with the route, one `getblock` at verbosity 2 on one without |

**Gentle by construction.** The backfill and `follow` share their own RPC client with one slot, so they never hold one of the four slots the mempool tracker and the summary routes share, and the node sees at most one RPC call from them at a time. Their Esplora requests are small (ten headers, one txid, a block listing of about 0.3 MB) and each task makes one at a time, so at most two are in flight. After each step the backfill waits so that it keeps that call busy for at most `BACKFILL_BUSY_PERCENT` of the time (50 by default). A failure of any kind, the node's 503 (`busy`) included, pauses it for 5 s, doubling up to 5 minutes, and is logged at the 1st, 2nd, 4th, 8th… in a row.

**Resumable.** The table is the progress. Each pass starts at the tip and looks for missing rows: it skips every 1,008-height bucket whose [totals](#totals) count 1,008 rows, and reads the rest 10,000 heights at a time. On a full mainnet table a pass reads about 970 bucket counts, 0.05 to 3 ms (it read every height, 98 ms, before the totals). So a restart or a pause (`BACKFILL_ENABLED=false`, then `true`) costs that and nothing else. The tip is checked every minute, and a new one restarts the pass from the top, so new blocks below the zone are filled first.

**Observable.** `block_backfill_progress` every minute while steps write rows, and once when a pass completes ([`LOGGING.md`](LOGGING.md)); once everything is done it stops, since only `follow` changes the table then. The same numbers are in `BlockTable::progress` for a status page. The row counts in it are sums of the [totals](#totals), 0.06 ms; before the totals they were two counts over the table (11 ms on mainnet's, and a timeout on a stalled machine), taken every minute forever.

**Cost on mainnet,** measured with `cargo run --release -p engine --example blocks_probe` over a private network, paced at 50%, on bounded ranges of each era. Time per block is the node calls' wall time including the round trips; at 50% busy, wall time is twice that. The totals and the `getblock` rows were measured against a synced rbitcoin v0.9.2; the listing route's rows on 2026-11-12 against a build of rbitcoin's `master` with it, while the node also served another server's full backfill (1,000 consecutive blocks below the tip, 100 in each older era). In the same hour, 50 consecutive recent blocks through `getblock` (`LISTING=getblock`) took 1.3 s and 10.3 MB each.

| Tier | Blocks around | Node time a block | Read a block |
|---|---|---|---|
| Totals | 0 to 75,000 (2009–10) | 7 to 10 ms | 0.9 KB |
| Totals | 225,000 (2013) | 12 to 14 ms | 0.9 KB |
| Totals | 375,000 to 525,000 (2015–18) | 12 to 22 ms | 1.1 KB |
| Totals | 675,000 (2021) | 21 to 25 ms | 1.3 KB |
| Totals | 862,000 to the tip (2024–26) | 32 to 35 ms | 1.3 to 1.4 KB |
| Rates | 75,000 | 38 ms | 5 KB |
| Rates | 225,000 to 375,000 | 0.2 to 0.45 s | 2 to 4 MB |
| Rates | 525,000 | 1 s | 4.7 MB |
| Rates | 675,000 | 1.6 s | 9.2 MB |
| Rates | 862,000 to the tip | 0.8 to 2.2 s | 10.5 MB |
| Rates, listing route | 75,000 | 27 ms | 1 KB |
| Rates, listing route | 225,000 to 525,000 | 36 to 97 ms | 40 to 99 KB |
| Rates, listing route | 675,000 | 53 ms | 198 KB |
| Rates, listing route | 862,000 | 90 ms | 327 KB |
| Rates, listing route | the newest 1,000 below the tip | 61 ms | 322 KB |

For all of mainnet (975,000 blocks), extrapolated era by era:

| Work | Node time | Read | At the default 50% |
|---|---|---|---|
| Totals for every block | 5.7 h | 1.2 GB | 11.4 h alone |
| Fee rates for a year (52,560 blocks, the default), listing route | 53 min | 17 GB | 1.8 h alone |
| Fee rates for a year, `getblock` | 13.4 h | 550 GB | 27 h alone |
| Both, interleaved, listing route | 6.6 h | 18 GB | everything after about 13 h |
| Both, interleaved, `getblock` | 19 h | 550 GB | totals complete after about 21 h, everything after about 38 h |
| Fee rates for all of history, listing route | 15.5 h | 134 GB | 31 h alone; with the totals interleaved, 21 h of node time and everything after about 42 h |
| Fee rates for all of history, `getblock` | about 9.7 days | | why the default is a year |

**Measured** on a full mainnet run at the defaults, on one machine, against a node with the listing route on the same private network ([`DEPLOY.md`](DEPLOY.md#one-day-on-mainnet)). It started from an empty store at 09:12 UTC on 2026-11-12; every block's totals were in at 03:23 the next day, 18 h 11 min later, and the year of fee rates at 04:22, 19 h 10 min after the start. **This is the figure to plan with**; [`CONFIG.md`](CONFIG.md#block-table) and [`DEPLOY.md`](DEPLOY.md#the-first-start) point here rather than repeat it. What the elapsed time includes:

- Twelve restarts for new builds, each a few seconds, and one run of 15 minutes with the backfill off. The table is the progress, so each restart lost only its pass's first reads.
- The node was busy with the backfill for 9.4 h of it, the default 50% of the time it ran.
- For the first eight hours the builds read fee rates through `getblock`: 41.7 GB for about 4,600 blocks, 9 MB a block. From 17:20 they used the listing route. The last run, 23:01 to the end, read 14.3 GB for 494,035 blocks' totals and 42,828 blocks' fee rates: the estimate above (1.2 GB and 17 GB) holds. In all, 59.7 GB.
- The site was offline from about 23:11 to 03:40; the node link was not, and the backfill ran on.

Signet took 3 h 13 min for its totals and 5 h 20 min for everything; testnet4 1 h 21 min and 2 h 17 min. Through `getblock` alone, the year of fee rates is still the estimate above, 13.4 h of node time, about 27 h at 50%: no full run measured it.

**The defaults on a node with the listing route.** `BACKFILL_FEE_RATE_DEPTH` at a year and `BACKFILL_BUSY_PERCENT` at 50 now rate the year in under an hour of node time, inside the time the totals take anyway. A depth covering every block would cost 15.5 h of node time and 134 GB read, and finish everything in about 42 h at 50%, about what a year cost through `getblock`. Through `getblock` the same depth would still cost about 9.7 days. The defaults are unchanged; which to pick is the operator's, and a later change.

**A real run.** The server, release build, a fresh `DATA_DIR`, mainnet with the mempool engine off and the backfill at its defaults, for ten minutes on 2026-11-12 against the node with the route (and another server's full backfill): it found the route by its probe, kept its call busy 31 s of each minute, and wrote about 620 rows of totals and 12.4 fee rates a minute, reading 4.5 MB a minute. The rates tier runs one step per totals step, and a totals step of 50 blocks took about 2.5 s of node time under that load, so while totals are still missing the rates go at the totals' pace; alone, at 61 ms a block, they would go at about 490 a minute. Interleaved the same way through `getblock` at 1.3 s a block, it would rate about 8 a minute.

**What it costs the node per hour** at 50%: one call from the backfill for half the hour, so 30 minutes of one of the node's 16 RPC work slots, and nothing while the other four shared slots are busy, since it never uses them. While it rates recent blocks alone it reads about 9.5 GB an hour through the listing route (322 KB every 0.12 s), or about 7 GB an hour through `getblock` (one 10 MB `getblock` every 5 s, most of it the node's JSON encoding); interleaved with totals, measured, 270 MB an hour through the route; once the year is rated, about 80 MB an hour, and when caught up, one `getblockstats` and a coinbase lookup per new block. Old blocks' totals are mostly round trips: `/block/:hash/txid/0` is one request per block, about 8 ms over the network measured and far less on the node's own host.

Unfiltered `getblockstats` took about 1 s per recent block (its UTXO statistics), forty times the filtered call; the backfill never asks for them ([`RBITCOIN.md`](RBITCOIN.md)).

#### Reading

`crates/engine/src/blocks/db.rs`, each an `async fn` on a read-only connection:

| Call | Returns | 975,000 rows, the last year rated |
|---|---|---|
| `by_height(store, h)`, `by_hash(store, hash)`, `by_hashes(store, hashes)` | `Row`: every column, `rates: Option<Rated>` for completeness, `Row::facts()` in the block facts route's shape | 0.04 to 0.15 ms |
| `page(store, below, limit)` | Up to `limit` (at most 1,000) rows below a height, newest first; missing heights skipped | 0.1 to 0.3 ms for 15 or 100 rows, at the top or deep in history |
| `heights_between(store, from, to)` | The heights timestamped in a period, through the `time` index | 1.7 to 2.6 ms for a year |
| `periods(store, from, to, Period::Day \| Period::Blocks(n))` | One `Bucket` per UTC day or per `n` heights, oldest first: block count, first and last height and time, sums of transactions, size, weight, fees, subsidy and reward, mean difficulty, and mean fee-rate percentiles over the rated blocks. By day or by 18, 36, 72, 144, 216 or 1,008 heights over 2,016 heights or more, from the [totals](#totals) | By day: 0.8 ms for three years, 4 ms for all of history (were 89 and 568 ms). By 1,008: 0.6 ms for all of history (was 573 ms). By 216 for three years 0.6 ms (was 87). Other `n` scan the rows: 0.5 to 0.8 s for all of history in 2,016-block buckets |

For the mining routes, `crates/engine/src/blocks/mining.rs` (and `pool_page` in `db.rs`):

| Call | Returns | 975,000 rows |
|---|---|---|
| `span(store)` | The tip and the lowest height from which every row up to it is stored: skips the full 1,008-height buckets, then walks rows to the first gap | 0.08 ms (was 93 ms: it walked every row) |
| `row_counts(store)` | Rows, and rated rows: a sum of the 1,008-height buckets | 0.06 ms (was 11 ms) |
| `pool_counts(store, from, to)` | Blocks, empty blocks and reward per pool over a range, most blocks first: whole 1,008-height buckets from the totals, the ends from the rows | 0.15 ms for a week; 2.2 ms for all of history (was 228 ms) |
| `pool_weeks(store, from, to)` | Blocks per pool per week from Monday 00:00 UTC: whole weeks from the totals | 3 ms for all of history (was 260 ms) |
| `pool_page(store, pool, from, below, limit)` | One pool's rows below a height, newest first | 0.2 ms for 100 |
| `retargets(store, floor, from, to)` | Each retarget's time and difficulty, with the period before's when that is stored at the floor or above | 0.9 ms for all of history |
| `work(store, from, to)` | Difficulty summed over a range and its first and last time: a hashrate estimate's inputs | |
| `at_or_before(store, floor, time)`, `first_since(store, floor, time)` | The newest block stamped at or before a time, through the `time` index; the lowest height stamped at or after one, from the rest of that day in the `time` index and the later days' totals; both at the floor height or above | 0.4 ms; `first_since` 0.1 ms for three years back (was 3.3 ms, and grew with the period) |
| `top(store)` | The highest row's height and hash | |
| `reattribute(store, pools)` | Redoes the `pool` column if the list changed (above) | 1.8 s for every row |

Measured with `MINING_BENCH_DIR=<dir> cargo test --release -p engine -- --ignored --nocapture mining_benchmark`, which writes 975,000 rows attributed as they go in 9 s (attribution adds about 2 µs a row).

Measured on the machine and load described under [Measurements](#measurements) with `cargo test --release -p engine -- --ignored --nocapture read_benchmark`: 975,000 realistic rows written in 7 s, 295 MB.

The figures with a "was" were measured on 2026-11-13 on a copy of a synced mainnet store (975,672 rows, 547 MB), before and after the totals, with `TABLE_BENCH_DIR=<dir> TABLE_BENCH_NET=mainnet cargo test --release -p engine -- --ignored --nocapture table_reads_benchmark` (median of five; load average 8 to 13 before, 30 to 50 after, from other builds). How each scales is in [`PERFORMANCE.md`](PERFORMANCE.md#6-reads-that-grew-with-the-block-table-done).

#### Totals

A read over all of history used to scan every row: a few hundred milliseconds each on a full mainnet table, run again on every new block for every answer the mining routes keep, so a busy machine pushed them past the store's 2 s read limit. The totals keep, per bucket, what those scans compute, so the reads add up a few thousand buckets instead. Code: `crates/engine/src/blocks/totals.rs`.

| Table | Bucket (`kind`, `key`) | Holds | Rows on mainnet |
|---|---|---|---|
| `block_totals` | a UTC day (0, `time / 86400`), or `n` heights (`n`, `height / n`) for the block series' points past a month: 18, 36, 72, 144, 216 and 1,008 | Exactly the row `periods` computes for the bucket: block count, first and last height and time, the sums, mean difficulty, rated blocks and mean fee-rate percentiles | 113,637 |
| `pool_totals` | 1,008 heights (1008, `height / 1008`), or a week from Monday 00:00 UTC (7, `(time - 345600) / 604800`) | Per pool with a block in it: blocks, empty blocks, reward | 29,904 |

About 16 MB on mainnet with the index `block_totals_reach` (`kind`, `last_height`), which finds the buckets that reach a height range.

**How they stay true.** A bucket is never adjusted by a difference: it is recomputed from its rows by the very statement the scan runs (`periods`' own SQL, and the pool scans' aggregates), so a stored bucket is bit for bit what the scan gives, the mean of floating-point values included. Three triggers on `blocks` (insert, delete, update) record in `totals_dirty` each bucket the old and the new row fall in. Before any write that changed `blocks` commits, the store calls `blocks::settle`, which recomputes each recorded bucket once (deleting it when it has no rows left) and empties `totals_dirty`, in the same transaction. So every writer is covered without knowing of the totals: `follow`'s replacements and deletions above a fork, the backfill's inserts and stale-row deletions, a rating's update, `reattribute`'s pool changes, a test's raw SQL. `INSERT OR REPLACE` removes the row it replaces without firing delete triggers unless `recursive_triggers` is on, so the writer turns it on ([Pragmas](#pragmas)). Readers see a row and its buckets change in the same commit.

**How a read uses them.** Only over 2,016 heights or more; a shorter range is scanned, as its rows are about as few as its buckets. A stored bucket is used when every one of its rows lies in the range (its first and last height say so); a bucket at either end of the range is computed from the rows in range by the scan, so the answer is always the scan's. A read takes one snapshot (`BEGIN`) for its buckets and its ends.

**Cost of keeping them.** A new block's write, its buckets settled, took 0.9 ms (median of five; 13 ms while another writer committed 10,000-row writes back to back), and rating it 0.8 ms. A backfill batch of 50 rows touches a few buckets of each kind.

**Proved exact** by `totals_equal_a_scan_through_every_kind_of_change`: from a table backfilled with gaps, 30 random steps (in CI; each kind of change at least once) of new tips, old blocks backfilled out of order, blocks rated later, reorgs that delete and replace rows (some leaving the chain shorter), stale rows deleted, pools re-identified as `reattribute` writes them, and restarts, with rows whose times run out of order, empty blocks, a few pools and distinct difficulties and fee rates. After every step, every stored bucket equals the scan's, every bucket the scan gives is stored, `totals_dirty` is empty, and each read (`periods` by day, 1,008 and another kept size, `pool_counts`, `pool_weeks`, `first_since`, the row count, and the bounds the backfill and `span` skip by) equals the scan over the whole table and over random ranges. `TOTALS_STEPS` and `TOTALS_SEED` run it longer: 100 steps, and 1,500 steps on three other seeds, passed too.

##### Filling the totals

Migration `0010` creates the tables and triggers but does not fill them: on a full mainnet table that is seven grouped passes over 547 MB, 8 s in one transaction measured with the `sqlite3` tool, holding the writer the whole time. It writes `totals_pending` instead, with the height below which rows are not totalled yet. The server then fills them in the background (`blocks::fill_totals`, from the mining task), newest first, 10,000 heights a write: each write marks every bucket those rows touch and settles them. Rows written meanwhile are totalled by the triggers as usual, and a bucket recomputed twice is still exact. When the last chunk is done the row goes and `block_totals_filled` is logged ([`LOGGING.md`](LOGGING.md)); a failure is logged as `mining_failed` (`task`: `totals`) and retried, and a restart resumes from the row.

On the mainnet copy: 98 writes, 4.6 s in all, the longest write 61 ms; 1,000,000 generated rows took 100 writes, 4.6 s, the longest 70 ms. **Until it is done every read scans as before**: each read checks `totals_pending` in its snapshot, so a half-filled table is never summed. Meanwhile `pool_counts` over all of history took 258 to 309 ms, as before the change. A new file has no rows, so it starts with the totals ready.

### audits

One row per block audited when it arrived ([`MEMPOOL.md`](MEMPOOL.md#block-audits) has the method and the categories). The code is `crates/engine/src/audit/`.

| Column | Type | Why |
|---|---|---|
| `hash` | 32-byte blob, key | Every per-block route asks by hash. Keyed by hash, not height, so a block that leaves the best chain keeps its audit |
| `height` | integer, indexed | Pages of scores by height, joined to `blocks` on height and hash so only the best chain's are listed |
| `time` | integer | The header's timestamp: the match rate over time (`predictions`) |
| `seen_at` | integer | When we learnt of the block, Unix seconds: what `fresh` was measured from |
| `match_rate` | real | The score, percent, two decimals |
| `expected_*`, `actual_*` | integer × 8 | Transactions, vsize, weight and fees of the expected block and of the mined one (coinbase left out) |
| `matched_*` … `unseen_*` | integer × 14 | Transactions and vsize of each of the seven categories |
| `txs` | blob | The listed transactions, every category but `matched`: at most 1,000 records of 45 bytes (txid, kind, vsize, rate in sat per 1,000 vB, accept time or 0), the most telling kinds first, then highest rate. The totals count every one; a reader compares them to tell a capped list |

**No audit is a missing row,** and that is a real answer: the server was not running, had no projection on the parent, or the projection was stale or for another block. Rows are written once, when the block arrives (`INSERT … ON CONFLICT DO NOTHING`): the first audit of a block stands.

**Size.** About 300 bytes of totals and index, plus 45 bytes per listed transaction: 2.3 and 3.5 KB for the two mainnet blocks measured ([`MEMPOOL.md`](MEMPOOL.md#on-mainnet)), so about 150 MB a year and at most about 45 KB, for an empty block against a full expectation.

**Not rebuildable.** The expectation existed only in memory at the moment the block came. Deleting the file loses every audit.

#### Reading

`crates/engine/src/audit/db.rs`:

| Call | Returns |
|---|---|
| `by_hash(store, hash)` | One block's `Audit` with its listed transactions |
| `by_hashes(store, hashes)` | Each block's totals, in order, without the lists: the block facts |
| `scored_between(store, from, to)` | Score, expected fees and weight of the best chain's audited blocks in a height range, lowest first |
| `scored_since(store, time)` | The same for the blocks stamped since a time |
| `write(store, audit)` | Stores an audit unless the block has one |

### mempool_history

What the mempool looked like over time: its size, fees and fee bands through the day, the week and the year, for the mempool chart and `/api/v1/statistics` ([`API.md`](API.md#mempool-statistics)). The code is `crates/engine/src/history/`; the server runs it from `crates/server/src/statistics.rs`.

**Sampling.** One task per network, started with the mempool engine when the network has a store. At every whole minute of the wall clock it reads the projection's totals (the whole mempool, exactly what the `mempool` topic sends), the node's `mempoolminfee` from the tracker's own probe, and the flow it counted on the tracker's change stream since the minute before: what entered, what left, and of that what was confirmed. It keeps the virtual size of every mempool transaction to count removals (a removal carries only the txid): about 37 bytes each in its hash table, 4.8 MB at 75,000 transactions. It asks the node nothing. A minute is left out, never stored as a guess, when:

| Reason | When |
|---|---|
| `syncing` | The engine has not finished its first cycle, or this is the first minute after start, after a minute the engine was not live, or after a late one: the flow over it was not watched whole |
| `stale` | The projection is stale: the node is failing and the numbers are the last good ones |
| `lagged` | The sampler fell more than the change stream's 64 deltas behind, so the minute's flow is incomplete |
| `late` | It read the state more than 5 s from the minute (a stalled process, a loaded machine, a clock that jumped ahead), or after the next minute had begun: the state is not that minute's and the flow would not span one minute. The minute after a late one is skipped too (as `syncing`), since its flow began off the minute |
| `store_busy`, `store_failed` | The write queue was full (`try_write`), or the write failed |

So a gap in the table is the truth: the engine was off, the node was failing, or the server was down. History starts when the server first ran with the engine on and a `DATA_DIR`.

| Column | Type | Why |
|---|---|---|
| `level`, `time` | integer key | 0 a minute, 1 an hour, 2 a UTC day; the minute sampled (Unix seconds), or the period's start |
| `samples` | integer | Minutes sampled in the row: 1 for a minute, at most 60 for an hour and 1,440 for a day. The coverage the routes report |
| `count`, `vsize`, `fees` | integer | Transactions, sigop-adjusted virtual size and base fees (sats) in the mempool |
| `min_fee` | integer | `mempoolminfee` in sat per 1,000 vB |
| `band0` … `band9` | integer | Virtual size in each of the ten stored [fee bands](#fee-bands), `band0` all under 0.2 sat/vB, by effective rate as the projected blocks band it; they sum to `vsize` |
| `in_count`, `in_vsize`, `out_count`, `out_vsize`, `mined_count`, `mined_vsize` | integer | The flow over the minute before the sample: entered, left for any reason, and confirmed |
| `band0_12_15`, `band0_15_20` | integer, nullable | The parts of `band0` in [0.12, 0.15) and [0.15, 0.2) sat/vB. `NULL` for a minute sampled before `0010`, and for any row or point summed from one |

**Every value is a sum over the row's `samples`.** A minute row holds its values as they are; an hour row the sum of its minutes. So rolling up adds rows together with nothing lost (a mean is the sum over `samples`, and flows are totals), and two roll-ups of the same period merge. The split columns sum only when every row summed has them (`CASE WHEN count(c) = count(*) THEN sum(c) END`), and a merge into a row without them stays without (`NULL + x` is `NULL`): an hour holding one minute from before the split does not know its split.

**Retention.** Minutes for 8 days, hours to 400 days, days after that. The 8 days cover a week of ten-minute points, the 400 a year of eight-hour points: no interval mixes rows coarser than its points ([`API.md`](API.md#mempool-statistics)). Neither is a setting; nothing needs it.

**The roll-up** runs in the writer, in the same write as every sample: the minute rows of every whole hour older than 8 days are summed into that hour's row (merged with one already there) and deleted, then the same for hour rows of whole UTC days older than 400 days. One write, so it is all or nothing: a crash or an error leaves the rows as they were, and the next minute does it again. Run twice it changes nothing. A sample for a minute whose hour or day is already rolled up (a clock that ran days ahead and was set back) is not stored, so no minute is counted twice; and when the clock goes back, the sampler drops the flow it was counting and samples again only after a whole minute past the last one it stored. With nothing to do it costs two index probes; once eight days are stored, it moves one hour of minutes an hour. After a long stop it catches up in the first write: a year of minutes took 0.56 s.

**Size.** A minute row is about 93 bytes on disk (a year of minutes alone, unrolled, was 49 MB for 529,000 rows). The bound is 11,520 minute rows and 9,408 hour rows, plus one row a day beyond 400 days: ten years held 24,180 rows in 2.5 MB, and each further year adds 365 rows, about 34 KB.

**Reading.** `history::series(store, interval, now)`, one read: a point per step with at least one sample, from the period's start to `now` (rows stamped later, by a clock that ran ahead, are left out) (a step with none has no point, so a chart shows a gap, not a zero), each point the sums and `samples` of its rows; the oldest stored time; and the minutes the period owes against the minutes sampled. Measured with `HISTORY_BENCH_DIR=<dir> cargo test --release -p engine -- --ignored --nocapture history_benchmark` on a table at the ten-year bound (on the machine under [Measurements](#measurements), load average 10 to 20):

| Interval | Points | Median of 5 |
|---|---|---|
| `2h` | 121 | 0.15 ms |
| `24h` | 1,441 | 1.3 ms |
| `1w` | 1,009 | 5.0 ms |
| `1m`, `3m`, `6m` | 721, 1,081, 1,081 | 5.8 to 7.6 ms |
| `1y` | 1,096 | 12 ms |
| `2y`, `3y`, `4y` | 730, 1,095, 730 | 13 ms |
| `all` (ten years) | 914 | 15 ms |

**Rebuildable:** no. It was observed live; deleting the file loses it.

### replacements

The replacement record ([`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)), so that what replaced what survives a restart: the transaction page's "replaced by", the `tx:` topic and the `/api/v1` replacement and first-seen routes ([`API.md`](API.md#transactions)). The code is `crates/engine/src/replacements/db.rs`; the server writes it from `crates/server/src/replacements.rs`.

| Column | Type | Why |
|---|---|---|
| `n` | integer key | The order recorded, newest highest: what the bound keeps and what the trees list newest first |
| `txid` | 32-byte blob, unique | The replaced transaction. A transaction replaced again (it came back) replaces its row |
| `by` | 32-byte blob, indexed | Its replacement. Indexed to mark a replacement mined, and to walk a history backwards |
| `seen` | integer | Unix seconds we saw it replaced |
| `fee`, `vsize`, `weight`, `value`, `time`, `rbf` | integer | The replaced transaction's base fee and total output value (sats), sigop-adjusted vsize, weight, the node's accept time and whether it signalled BIP 125 |
| `by_fee` … `by_rbf` | integer or `NULL` | The same for the replacement; all `NULL` when the tracker never held it (it was confirmed in the block that removed the original) |
| `mined` | integer | Whether the replacement is confirmed: 0 not mined, 1 mined, 2 unknown (a reorg took its block away and where it is now is not known yet, [`MEMPOOL.md`](MEMPOOL.md#following-a-transaction)) |
| `height`, `block` | integer, 32-byte blob, or `NULL` | The block that confirms it, when `mined` is 1. Rows written before migration 0008 have `mined` 1 and no block: they are left as they were, read as mined, and no reorg re-examines them |

**Writes.** One writer task per network takes the record's changes from a queue of 64, one entry per tracker delta or check of a reorg, with whatever else is queued, and writes them in one transaction in the order the record made them: `INSERT OR REPLACE` per new link (after deleting the replacement's own row, which no longer stands now that it is back), an indexed `UPDATE` of `mined`, `height` and `block` per replacement whose state changed (confirmed, or moved by a reorg), and for a transaction back in the mempool (or confirmed by a reorg itself) a `DELETE` of its own row and an `UPDATE` clearing `mined` on what it replaced; then `DELETE` of every row more than `REPLACEMENTS_KEPT` places behind the newest (a deleted row's place still counts, so the table may hold fewer, never more). All or nothing: a crash or an error leaves the rows as they were, and memory still has the links. The tracker and the task that follows it never wait for the store: a full queue drops the write and logs `replacements_store_failed`.

**Reading.** `load(store, keep)` once, when the mempool engine starts: the newest `keep` rows, put back into the record oldest first. 10,000 rows took 3.6 ms (below). Requests never read the table; they read the record in memory.

**Size.** At most `REPLACEMENTS_KEPT` rows (10,000 by default). Measured with `cargo test --release -p engine -- --ignored --nocapture replacements_benchmark` (20,000 links written 20 at a time, so the bound had pruned half): 10,000 rows, 2.06 MB for the table and its two indexes, 205 bytes a row; reading them back took 3.6 ms.

**Rebuildable:** no. The node does not keep replaced transactions; deleting the file forgets every replacement seen before.
### fee_samples and fee_blocks

The evidence for the score the server keeps of its own fee recommendations ([`MEMPOOL.md`](MEMPOOL.md#the-score-the-server-keeps)): enough to score every sample again, and nothing more. The code is `crates/engine/src/fees/db.rs`; the server writes it from `crates/server/src/ws/fees/score.rs`.

| Table | Column | Type | Why |
|---|---|---|---|
| `fee_samples` | `time` | integer key | Unix seconds the answer was read, every 30 s |
| | `served` | integer | 0 ours, 1 the node's estimates (warming up, or the projection stale), 2 nothing. Samples not ours are kept only to be counted |
| | `high`, `medium`, `low`, `no_rush` | integer or `NULL` | Our answer for 1, 3, 6 and 144 blocks, sat per 1,000 vB; `NULL` unless `served` is 0. The minimum is not stored: nothing scores it |
| `fee_blocks` | `height` | integer key | A block that replaced another at its height (a reorg) replaces its row |
| | `time` | integer | Unix seconds the server saw it: the scorer orders blocks and samples by it |
| | `clearing` | integer or `NULL` | The rate that sufficed to get in, sat per 1,000 vB; `NULL` when no projection before it held any of its transactions, or it came while the server was down |

**Writes.** The keeper hands each sample and each block's rows to a writer task through a queue of 64, tagged with the store's generation when it read them, and the writer commits them in order with `write_from`, through the gate like every write: one write every 30 s, and one per block. A full queue drops the write (the record in memory keeps it) and counts it in the next `fees_score` line's `unsaved`. Each write also deletes samples older than 30 days, and a write with a block deletes blocks older than 31: the oldest sample's day-long horizon still has its blocks. Both are rowid-ordered deletes.

**Reading.** `load` once, when the engine starts: every row still in its retention, about 90,000 samples and 4,500 blocks at the bound. Requests never read the tables; they read the scores kept in memory.

**Size.** Measured on a table filled with a month of mainnet-shaped rows: 21.9 bytes per sample and 17 bytes per block, about 65 KB a day (2,880 samples and 144 blocks), and under 2 MB at the 30-day bound.

**Rebuildable:** no. It was observed live; deleting the file starts the score over.

### ln_channels

Every public channel the Lightning peer verified, and how it ended: what a node's channel list, a channel's page and the tx page need once gossip has forgotten a closed channel ([`LIGHTNING.md`](LIGHTNING.md#in-the-server)). The code is `crates/engine/src/lightning/`; the server feeds it from `crates/server/src/lightning.rs`.

| Column | Type | Why |
|---|---|---|
| `scid` | integer key | The short channel id: funding height, transaction index and output index. Ordering by it orders channels by where they were funded, so the newest opens are a walk down the key |
| `node_one`, `node_two` | 33-byte blobs | The nodes' public keys, as announced: a node's channels, open or closed. Each indexed |
| `capacity` | integer, sats | The funding output's value, as the node reported it |
| `open_hash`, `open_time` | blob, integer | The funding block (its height is the scid's) and its header time: a channel's age |
| `close_height`, `close_hash`, `close_time`, `close_txid` | nullable | The block and transaction that spent the funding output. Null while open. Indexed by height (partial index) for the newest closes, and by txid for the transaction page |
| `open_txid` | blob, nullable | The funding transaction, asked of the node once per channel in the background ([`LIGHTNING.md`](LIGHTNING.md#funding-transactions)). Null until then; cleared when an `Opened` moves the channel to another block. Indexed, for the transaction page; a partial index on the rows still without one is what the background task walks |
| `close_kind` | integer, nullable | 0 cooperative, 1 force, 2 penalty, 3 other ([`LIGHTNING.md`](LIGHTNING.md#how-a-close-is-classified)) |
| `close_fee` | integer, nullable | The closing transaction's fee, when the node said |
| `penalty_txid`, `penalty_height`, `penalty_hash`, `penalty_time` | nullable | A force close found to be a breach: the revocation sweep. The close keeps its kind; the penalty columns say it was a breach |

**Kept as the peer's history says.** The peer streams numbered records ([`LIGHTNING.md`](LIGHTNING.md#history)); each is applied in order, in writes of up to 2,000:

| Record | Applied as |
|---|---|
| `Opened` | Insert, or make the row match and clear any close: the chain says the output is unspent, so a stored close left it. A row that already matches is not written |
| `Closed` | Insert or overwrite the open and close columns. A stored penalty stays when the close is the same transaction (the close found again after a restart) |
| `Penalty` | Fill the penalty columns of a closed row |
| `OpenUndone` | Delete the row: as if the open had never been seen. An `Opened` with the new block follows if the output is still at its position |
| `CloseUndone`, `PenaltyUndone` | Clear the close and penalty columns, or the penalty columns |

So a reorg leaves the table as if the undone record had never arrived, and applying a record twice changes nothing.

**Resuming.** Sequence numbers start at 1 in each process, so nothing about them is stored. The consumer subscribes to the stream before reading the peer's memory of recent records (`Peer::recent`), takes each record once (skipping numbers it has taken), and after a lag reads the memory again from the last number it took. After a restart the new peer sends `Opened` for every channel it verifies, which changes nothing for rows already stored, and finds closes that happened while it was down from the node's spend records ([`LIGHTNING.md`](LIGHTNING.md#catch-up)); those are applied like any other. A failed write is retried, the same records, after 1 s doubling to 32 s, until it lands; records leave memory only once committed, and at shutdown, once the peer has stopped, whatever is left is stored before the server exits. The tests feed one script of records live, as a backlog, through a lagging receiver, across a restart and past a gap, and require the same table each time.

**A gap.** If the consumer falls further behind than the peer's memory (10,000 records, five times the largest write; at the start-up burst of about 600 records a second that is a store stalled for 16 s), the records in between are lost. The consumer then stores every channel the peer holds open, as of a sequence number, and goes on from there (`lightning_history_gap`). Opens are whole again; a close among the lost records is not recorded, and its row reads open, like a channel the peer stopped watching ([`LIGHTNING.md`](LIGHTNING.md#limits)).

**Writes and size.** Through `try_write`: a full write queue makes the consumer wait and retry rather than take a slot, so the block table's and the mempool history's writes never queue behind it. This is stronger than the drop-and-log queue of the replacement record and the snapshots: a dropped channel record would be a hole nothing fills, so records are kept until committed and a lag is repaired from the peer's memory. Measured on mainnet: the first start writes one row per channel as validation verifies it, 36,219 in about two minutes, in writes of at most 2,000 records; a restart sends the same 36,219 records again and changes no row (an open that matches is not written). After that, a few hundred rows a day: the new opens and about 200 closes. About 150 bytes a row: 5.5 MB at 36,000 channels, 15 MB at the 100,000 ceiling. The funding txid and the lookup indexes (`0007`) add about 190 bytes a row once every txid is known (measured on mainnet with all 36,227 filled: the two node indexes 1.9 MB each, the funding-txid index 1.9 MB, the table 0.95 MB more): 6.8 MB at 36,000 channels, 19 MB at the ceiling. The table grows with the channels ever seen, not with time: each row stands for a funding output on the chain, and the graph's ceiling bounds how many are open at once.

**Not rebuildable.** Nodes, capacity and the funding block of a closed channel come from gossip that stops once it closes. Deleting the file loses every closed channel; open ones come back at the next start.

#### Reading

`crates/engine/src/lightning/db.rs`:

| Call | Returns |
|---|---|
| `opened(store, limit)` | Up to `limit` rows, newest funding first, with their closes |
| `closed(store, limit)` | Up to `limit` closed rows, newest close first, through the partial index |
| `channel(store, scid)` | One row, by its key |
| `node_closed(store, node, offset, limit)` | A node's closed rows, newest close first, and how many it has: through the node indexes, so it reads that node's rows only (2.3 ms for ACINQ's 1,807) |
| `node_spans(store, node)` | A node's rows' funding and closing times and capacity, for its history ([`LIGHTNING.md`](LIGHTNING.md#routes)) |
| `by_txids(store, txids)` | The rows each txid funded or closed: two index lookups per txid |
| `past(store)` | Every node's oldest funding time and closes by kind, and the oldest statistics row: one grouped pass over the table for the graph's index, done again only after new rows were stored |
| `unfunded(store, after, limit)`, `set_funding(store, found)` | The rows still without a funding txid, and storing them (`try_write`, and only while the row names the same block) |
| `apply(store, changes)` | Stores records in order, in one write; fails with `Error::Full` rather than wait |

### ln_statistics

The Lightning network's totals over time: channels, nodes, capacity, fee policies, for `/app/lightning/statistics/…` and `/api/v1/lightning/statistics/…` ([`API.md`](API.md#lightning)). Same shape and roll-up as [`mempool_history`](#mempool_history), at a ten-minute cadence.

**Sampling.** At every whole ten minutes of the wall clock the server reads the verified graph and stores one row (`crates/engine/src/lightning/sampler.rs`). A slot is left out, never stored as a guess, when the graph is not synced (`syncing`: a graph still downloading would undercount), when the server woke more than a minute after the slot (`late`), or when the write queue was full or the write failed (`store_busy`, `store_failed`). Reading the graph takes a few milliseconds (gossip waits meanwhile); the node is not asked anything.

| Column | Why |
|---|---|
| `level`, `time` | 0 a ten-minute snapshot, 1 an hour, 2 a UTC day; the slot, or the period's start |
| `samples` | Snapshots in the row |
| `channels`, `nodes`, `capacity` | Verified channels, nodes with a channel, and the channels' capacity in sats |
| `tor_nodes`, `clearnet_nodes`, `clearnet_tor_nodes`, `unannounced_nodes` | Nodes by the addresses they announce: onion only, clearnet only, both, none (or no announcement) |
| `med_capacity` | The median channel capacity |
| `policies`, `fee_rate`, `base_fee` | Directional channel policies counted in the averages, and their fee rates (ppm) and base fees (msat) summed. A policy over 1,000,000 ppm (a fee above the amount) or 1,000,000 msat (1,000 sats) refuses to route rather than prices it and is left out: on mainnet 118 of 48,247 policies were over the rate cap, up to 2³¹ − 1 ppm, and with them the average fee rate read 4,990,804 ppm; without, 981 |
| `med_fee_rate`, `med_base_fee` | The median fee rate and base fee over every policy, the outliers included |

**Rolling up does not lie.** Every value is a sum over the row's snapshots, so hours and days add rows together with nothing lost. A mean over any period is a sum over `samples`; the average capacity is `capacity / channels` and the average fee rate `fee_rate / policies`, both exact over the period's snapshots. A median cannot be rolled up, so the median columns hold the snapshots' medians summed: a period's value is **the mean of its snapshots' medians**, and the routes say so. A median is the lower of the two middle values for an even count.

**Retention, roll-up and bound** as `mempool_history`: ten-minute rows for 8 days, hours to 400 days, days after that, rolled in the same write as each snapshot, all or nothing (a failed write leaves the rows as they were, tested with a failing roll-up). At most 1,152 snapshot rows and 9,408 hour rows, plus one a day beyond 400 days: about 71 bytes a row (measured for 10,000 rows), 0.75 MB after a year and 26 KB a year after that. One write every ten minutes, measured at 0.4 to 2.1 ms on mainnet.

**Reading.** `lightning::series(store, interval, now)`: the intervals of `history::Interval`, with no step finer than ten minutes, so `2h` has 12 points and `24h` 144; the coverage counts ten-minute slots. `lightning::latest(store)`: the newest row.

**Rebuildable:** no. It was observed live.

### ledger

Running totals, and the whole list of transactions, for a bounded set of very large addresses, whose totals the node refuses above its `--max-sh-creates` or takes seconds to give and whose history pages each cost it as much as the first ([`RBITCOIN.md`](RBITCOIN.md#address-history-cost)). The code is `crates/engine/src/ledger/`; the server's use of it, seeding, its bounds and its routes, in [`API.md`](API.md#very-large-addresses).

- **Seeded once.** `ledger::seed` asks the node for the script's totals (through its socket's uncapped route where it has one, [`RBITCOIN.md`](RBITCOIN.md#totals-of-large-addresses)) pinned with `?asof=` to a block the ledger holds (one below its tip, since the address index can trail the tip; below the node's tip when nothing is tracked), and optionally the newest history page at the same block. Blocks the ledger applied after that block are read again and applied to the new script alone, in the same write, which commits only if the ledger's tip has not moved. The node's size refusal is `Seeded::Refused`.
- **Kept from blocks.** `ledger::follow` reads each new block once with `getblock` verbosity 3 (every output's and every spent output's script and value) and applies it to every tracked script in one write: funded count and sum per output paying the script, spent count and sum per input spending one of its outputs, one transaction for either. All scripts are exact at one block, the highest row of `ledger_chain`. With nothing tracked it asks the node nothing.
- **Reorgs.** The last 100 blocks applied (`ledger_chain`) and what each did to each script it touched (`ledger_undo`) are kept. A block that left the best chain is subtracted, its rows and chart points removed; a script seeded at or above it is dropped, to be seeded again. A reorg deeper than 100 blocks drops every script.
- **Newest transactions:** at most 200 per script (`ledger_txs`), always an exact newest-first prefix of the script's history in block order, with each row's value and time. The node lists a block's rows by txid, not by position ([`RBITCOIN.md`](RBITCOIN.md#the-whole-history-of-a-large-address)), so the seed's page leaves out its oldest block when the page is full.
- **Whole history** (`0015_ledger_history.sql`, `ledger_history`): every confirmed transaction of a kept script, as its height and txid, in the node's own order (height, then txid bytes), so a page of it is the node's page. `ledger::history` asks the node for the list once per script ([`RBITCOIN.md`](RBITCOIN.md#the-whole-history-of-a-large-address)), pinned to a block the ledger holds (one below its tip), and streams it into the store 10,000 rows a write, holding at most three batches in memory; the rows of the blocks applied after that block are read again and stored first. From then on each block applied adds the script's rows, and an undone block takes its rows away (and lowers the list's block below it, so the blocks applied in its place bring their rows). The state is `ledger_scripts.history`: 0 not taken (or the last try failed), 1 being taken, 2 whole, 3 refused by the node, 4 dropped. Rows are served only when whole, which the last write proves: the rows stored are exactly as many as the totals' `tx_count`; otherwise they are dropped and the list asked again later. A list longer than the totals' count is stopped as soon as it passes it, before it is all stored. A reorg below the list's block while it streams, a restart (`ledger::history_restarted` at startup), or any failure drops the rows and leaves the state 0, so nothing half taken is ever served. Rows are keyed by `hid`, new for each list, so rows of an abandoned list never mix with the next.
- **Bound on the whole histories.** All scripts' histories held or being taken, counted as their `tx_count`, stay within the server's `LEDGER_MAX_HISTORY_ROWS` ([`CONFIG.md`](CONFIG.md#very-large-addresses)). Before a list is asked, room is made by dropping the least recently viewed scripts' histories (state 4), never one viewed at or after the time the server gives (`viewing`: 30 minutes back, and 5 more since a view is stored at most every 5 minutes; a reader may be paging it; when only those could make room, `Historied::NoRoom` and nothing is written); a script with more transactions than the bound is never asked (state 5); at startup and after every round of following blocks (failed rounds included), `ledger::bound` drops the least recently viewed again if blocks made them outgrow it, and a list being taken last; and a list is checked against the bound again when it is done. So within one long catch-up the histories may pass the bound by that catch-up's blocks until it ends. A dropped history may be taken again (`ledger::history` accepts states 0, 3 and 4); when it was last taken whole is `history_taken` (Unix seconds, `0016_ledger_history_taken.sql`), from which the server allows it again only a day later and only for an address a reader views ([`API.md`](API.md#very-large-addresses)), so two busy addresses cannot make the node list each other in turn.
- **Filled once** (`0014_ledger_fill.sql`), only while its whole history is not kept (`ledger::unfilled` leaves out states 1 and 2; the server also waits while the list may still come, [`API.md`](API.md#very-large-addresses)). A script seeded without the page (from a totals answer, or its page failed) has only the rows since its seed block; `ledger::fill` asks for the page then, pinned to the seed block, so its rows are all older than the kept ones and none is in both. They join without a gap only if the kept rows are every transaction since the seed. `seeded_tx_count` (the totals' `tx_count` at the seed) proves it: `tx_count - seeded_tx_count` is the transactions since, and the rows kept since must be that many. A window cut at 200 and then shortened by a reorg holds fewer, with older ones gone. Scripts seeded before the migration get `seeded_tx_count` from `ledger_undo` when it still covers every block since their seed, and stay `NULL` otherwise. With 200 rows since the seed, a `NULL`, or a count that differs, nothing is added. `filled` is set in the same write as the rows, or alone when nothing can be added, and the node is never asked again for that script; a script seeded with its page has it set from the start, and so does one kept before the migration that already held rows at or below its seed block.
- **Chart:** the balance at the last block that changed it, one point per 144 heights (`ledger_points`).
- **Bounds.** `seed` takes the most scripts to track; past it, the least recently viewed (`viewed`, set by `ledger::touch`) is dropped.
- **Exactness.** After any sequence of connects, disconnects, restarts and catch-up after downtime, a script's totals equal the node's `/address/:a?asof=<tip>`, its newest transactions equal the node's own history, and a whole history equals the node's whole list. Tested with a fake chain and an independent oracle over random reorgs, restarts and blocks arriving while a list streams in, and against a real rbitcoin v0.9.2 on regtest (`cargo test -p engine -- --ignored ledger::tests::regtest::<test>`, see the comment in `tests.rs`).

**Cost**, measured on signet on 2026-11-14 with `NET=SIGNET cargo run --release -p engine --example ledger_cost` (read-only): `getblock` verbosity 3 averaged 115 ms and 1.4 MB a block over 20 blocks (8 to 238 ms, 37 KB to 4.8 MB). Following, beyond that read: 0.5 ms with nothing tracked (no node call), 26 ms a block with 1 script and 31 ms with the 1,000 most active scripts of 144 blocks, mostly four small RPC lookups. **Storage**, from SQLite's `dbstat`: a busy script holding a full window takes about 29 KB of `ledger_txs`, 12 KB of `ledger_undo` and about 60 bytes a day of chart; the 1,000 most active signet scripts took 3.7 MB after 144 blocks. A whole history takes 48.3 bytes a transaction in `ledger_history` (measured from `dbstat` for 70,952, 118,201, 125,776 and 1,908,610 rows on signet, 92.1 MB for the largest), so the default bound of 10 million rows is about 480 MB. Taking the 1.9-million-row list cost the explorer 10.3 MB of memory at its peak and 14 s ([`RBITCOIN.md`](RBITCOIN.md#the-whole-history-of-a-large-address)). On mainnet (2026-11-14, measured by the orchestrator on the live site) the first ten lists held 10.18 million rows, and the explorer's mainnet store was 1.04 GB after them.

## Pragmas

| Connection | Pragma | Why |
|---|---|---|
| file | `journal_mode=WAL` | Readers never block the writer and the writer never blocks readers. Stored in the file. Open fails with `OpenError::NoWal` on a filesystem that cannot do it |
| writer | `synchronous=FULL` | The WAL is fsynced at every commit, so a write that `write` acknowledged survives a crash and a power cut. The tests prove the crash half (a child process is killed mid-transaction); power loss rests on SQLite's documented `FULL` guarantee and a disk that honours fsync. With one writer and batched writes this costs little; `NORMAL` would lose the last commits on power loss |
| writer | `journal_size_limit=64 MiB` | The WAL is truncated back to this after a checkpoint, so one bulk insert does not leave a huge file behind |
| writer | `foreign_keys=ON` | SQLite ignores `REFERENCES` without it |
| writer | `recursive_triggers=ON` | Delete triggers fire for the rows `INSERT OR REPLACE` removes, so the block table's [totals](#totals) hear of every row that leaves |
| every | `temp_store=MEMORY` | No query needs a writable temporary directory: the image has none ([Temporary data](#temporary-data)) |
| every | `busy_timeout=5 s` | Only another process takes locks (a backup with the `sqlite3` tool); wait for it instead of failing |
| readers | `query_only=ON`, opened `SQLITE_OPEN_READ_ONLY` | Two independent guards against a write from a request handler |

Cache size and the auto-checkpoint interval stay at SQLite's defaults (2 MiB, 1,000 pages); see the measurements below for why.

Opening also runs `PRAGMA quick_check`: a file that is not a database, or whose pages are damaged, is refused with `OpenError::Corrupt` naming the file. It takes about 0.2 s on a million-row file.

## Temporary data

SQLite keeps transient data apart from the database: the sorter of a `GROUP BY`, `ORDER BY` or `DISTINCT` that no index serves, a materialised subquery, a transient index, and the statement journal of a write that changes many rows inside a transaction. By default it holds these in memory until they pass about 2 MB (the page cache) or, for a statement journal, 64 KB, then spills them to a file in the first writable temporary directory it finds (`SQLITE_TMPDIR`, `TMPDIR`, `/var/tmp`, `/usr/tmp`, `/tmp`, the working directory). The image has none: its root is read-only and only `/data` is writable ([`DEPLOY.md`](DEPLOY.md#reference-the-image)). So every query whose transient data passed the threshold failed with `disk I/O error`, and only at mainnet's size: on 2026-11-14 the first deployment's Lightning index was never built, because its grouped read of 36,000 channels spilled, while signet's 1,065 fitted.

**Every connection sets `temp_store=MEMORY`**, the writer and each reader, so transient data never leaves memory and the store needs nothing writable but its own directory. The alternatives: pointing SQLite at the data directory takes an environment variable read once per process (`SQLITE_TMPDIR`), so the binary would still depend on how it is started (the pragma that did it, `temp_store_directory`, is deprecated and process-wide too); a writable `/tmp` in the container is configuration every deployment must remember, and the failure it guards against is silent. The cost is memory, and only for the statements below, while they run.

**What it costs**, measured on 2026-11-14 with `dev/bigstore/bigstore.py`'s store (975,000 block rows with their totals, 40,000 channels among 15,000 nodes, a year of mempool and Lightning history, a year of audits, the fee score's 30 days, 10,000 replacements; 361 MB), each statement alone in the `sqlite3` 3.49 shell in a Linux container with a read-only root and no `/tmp`, as the server's user. Peak is SQLite's own allocator at its highest, page cache included (about 0.2 MB for an empty statement). Every distinct statement the test suite prepares (454) went through `EXPLAIN QUERY PLAN` on that store; these are the ones that sort, group, deduplicate, materialise or build an index at a size that grows with the data:

| Statement (where) | Rows it groups or sorts at this size | No temporary directory, before | Peak after | Peak with `/tmp` |
|---|---|---|---|---|
| Every node's oldest funding and closes, for the Lightning index (`lightning::past`) | 80,000 (two per channel) | `disk I/O error` | 7.3 MB, 45 ms | 4.3 MB |
| Mempool history over all of it (`history::series`, `1y` and longer) | 20,900 | `disk I/O error` | 4.7 MB | 4.4 MB |
| The block series from the totals, by 18 heights over the whole chain (`totals::periods`) | 54,000 | `disk I/O error` | 4.6 MB | 4.3 MB |
| Block periods, pool counts and pool weeks by scan over the whole chain (`periods_scan`, `pool_counts_scan`, `pool_weeks_scan`): only while an old file's totals are being filled ([Filling the totals](#filling-the-totals)); afterwards a scan covers fewer than 2,016 heights | 975,000 | `disk I/O error` | 78 MB (periods), 33 MB (pools), under 0.5 s | 4.4 MB |
| The same scans over 2,015 heights, the most they cover once the totals are filled | 2,015 | works | 1.0 MB | 1.0 MB |
| A backfill write of 10,000 new rows and their totals (`blocks` insert, then `settle`; measured as one `INSERT … SELECT`) | 80,000 `totals_dirty` rows | `disk I/O error` | 34 MB | 4.1 MB |
| The pool attribution's write of 10,000 heights (`reattribute`), as the server runs it | 160,000 `totals_dirty` rows | `disk I/O error` in the server ([below](#proving-it)) | works in the server; not measured alone | |
| Audits per pool over a year (`pool_health`), the block-totals pool sums, a node's closed channels for the node with the most (7,669), the fee blocks, the Lightning statistics series, a mempool-history roll-up of 8 days of minutes, a totals fill step | 4,500 to 52,000 | works | 0.3 to 3.9 MB | 0.3 to 3.7 MB |

So at mainnet's size a read costs at most about 8 MB more than before, and a write about 34 MB, except the whole-chain scans of a file whose totals are still being filled: up to 78 MB for one read, under the read time limit, once per old file. At most `Options::readers` (4) reads and one write run at once. Everything else the server runs is an indexed lookup or a range read in index order that needs no transient data.

### Proving it

The release workflow runs the image as [`deploy/compose.yml`](../deploy/compose.yml) hardens it (read-only root, no capabilities, no writable `/tmp`) against that store, with a stand-in node that answers only `getblockchaininfo` so the gate opens: the pool attribution rewrites all 975,000 rows, then 146 routes that answer from the store must answer `200` and no store read or write may fail ([`CI.md`](CI.md#releases)). Locally, with an image built:

```sh
python3 -I dev/bigstore/hardened.py rbitcoin-space   # about 30 s on an Apple M4
```

Against the image from before the fix it fails at the attribution's first write (`store_write_failed`, `io`, `disk I/O error`), and the mempool history's `1y`, `2y`, `3y` and `all` answered `500`; with the fix all 146 answer `200`. The Lightning index needs a synced gossip peer, which no test here has: its read is the first row of the table, proven in the shell, and the index task's failures are tested in `crates/server/src/lightning/index.rs`.

## Backup and recovery

The database is one file plus, while the server runs, its `-wal` and `-shm` companions. **Copying the `.sqlite` file alone while the server runs can produce a corrupt copy**, because recent commits live in the WAL. Take a consistent copy while it runs with the `sqlite3` tool:

```sh
sqlite3 data/mainnet.sqlite "VACUUM INTO 'backup/mainnet.sqlite'"
```

`VACUUM INTO` writes a compacted copy from one read snapshot and does not block the server's writes. `.backup` works too. With the server stopped, the three files can be copied as they are (after a clean stop the WAL is checkpointed and removed).

To restore, stop the server and put the copy in place, removing any old `-wal` and `-shm` files. To recover from a corrupt file, restore a backup or delete it.

**Deleting the file** loses only what was observed live: mempool history, first-seen times, block audits, Lightning channel history and statistics, and any other history a later feature records as it happens. Everything derived from the chain, such as block summaries, is rebuilt from the node by backfill. Each feature's doc says which of its tables are which.

## Measurements

Apple M4 (10 cores), APFS SSD, release build, while other builds ran on the same machine (load average 7 to 17). Reproduce with:

```sh
cargo test --release -p engine -- --ignored --nocapture bulk_insert_benchmark
```

**Bulk insert.** One million rows shaped like a block summary (height as the key, a 64-character hex hash with a unique index, nine integers, two short texts), in writes of 10,000 rows, with two readers running flat out:

| | Result |
|---|---|
| Throughput | 17,000 to 73,000 rows/s over 28 runs, median 38,000: a million rows in 14 to 59 s |
| Slowest 10,000-row write | 0.2 to 11 s; usually under 2.5 s |
| File size | 210 MiB, about 220 bytes a row with its hash index |
| Reopen with `quick_check` | 0.18 to 0.28 s |

The spread is the shared disk, not the code: the same build gave 17,000 and 71,000 rows/s in consecutive runs. With `synchronous=OFF` and no readers, one run reached 87,000 rows/s, so the time goes to fsync at commits and checkpoints. A 64 MiB writer cache with a 10,000-page checkpoint interval was no better than the defaults in an interleaved A/B (four runs each, both 17,000 to 71,000), so the defaults stay.

**Reads during that insert,** each on a random height among the rows committed so far:

| Query | Median | p99 | Worst |
|---|---|---|---|
| Lookup by hash (unique index) | 11 µs | 40 to 70 µs | 170 to 330 ms |
| 100-row range scan by height | 20 µs | 60 to 110 µs | 170 to 330 ms |

Each worst case hit both readers at the same moment, so it was one machine-wide stall, not a slow query. Readers never wait for the writer.
