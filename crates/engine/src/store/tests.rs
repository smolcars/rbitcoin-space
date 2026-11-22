#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};
use std::time::{Duration, Instant};

use super::migrate::{Migration, MigrationError, check_checksums, validate};
use super::*;

/// A directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("engine-store-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const M1: Migration = (
    "0001_items.sql",
    "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
);
const M2: Migration = (
    "0002_items_size.sql",
    "ALTER TABLE items ADD COLUMN size INTEGER;",
);

fn open(dir: &Path, migrations: &[Migration]) -> Result<Store, OpenError> {
    Store::open_with(dir, "regtest", Options::default(), migrations)
}

async fn version(store: &Store) -> i64 {
    store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("PRAGMA user_version")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap()
}

async fn count(store: &Store) -> i64 {
    store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM items")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap()
}

async fn insert(store: &Store, id: i64) {
    store
        .write(move |sql| {
            sql.prepare("INSERT INTO items (id, label) VALUES (?1, 'x')")?
                .execute(params![id])?;
            Ok(())
        })
        .await
        .unwrap();
}

#[test]
fn validate_accepts_a_sequence_and_rejects_mistakes() {
    assert_eq!(validate(&[]), Ok(()));
    assert_eq!(validate(&[M1, M2]), Ok(()));
    assert_eq!(
        validate(&[M1, ("0003_c.sql", "")]),
        Err(MigrationError::Gap {
            expected: 2,
            file: "0003_c.sql".into()
        })
    );
    assert_eq!(
        validate(&[M2]),
        Err(MigrationError::Gap {
            expected: 1,
            file: M2.0.into()
        })
    );
    assert_eq!(
        validate(&[M1, ("0001_again.sql", "")]),
        Err(MigrationError::Duplicate("0001_again.sql".into()))
    );
    for bad in [
        "1_a.sql",
        "0001_A.sql",
        "0001_.sql",
        "0001-a.sql",
        "0001_a.SQL",
        "00001_a.sql",
    ] {
        assert_eq!(
            validate(&[(bad, "")]),
            Err(MigrationError::BadName(bad.into())),
            "{bad}"
        );
    }
}

#[test]
fn checksums_catch_edited_missing_and_removed_migrations() {
    let lock = "# header\n0001_items.sql ad2b2d0c9e6d1e4c\n";
    let real = check_checksums(&[M1], "").unwrap_err();
    let line = real.lines().last().unwrap().to_owned();
    assert!(line.starts_with("0001_items.sql "), "{real}");
    assert_eq!(check_checksums(&[M1], &line), Ok(()));
    assert!(
        check_checksums(&[M1], lock)
            .unwrap_err()
            .contains("changed after it shipped")
    );
    assert!(check_checksums(&[], &line).unwrap_err().contains("gone"));
    let edited = (
        "0001_items.sql",
        "CREATE TABLE items (id INTEGER PRIMARY KEY);",
    );
    assert!(
        check_checksums(&[edited], &line)
            .unwrap_err()
            .contains("changed after it shipped")
    );
}

#[test]
fn shipped_migrations_are_numbered_and_unchanged() {
    validate(MIGRATIONS).unwrap();
    let lock = include_str!("migrations/CHECKSUMS");
    if let Err(e) = check_checksums(MIGRATIONS, lock) {
        panic!("{e}");
    }
}

/// A file a build before `0020` left at `0019` (the penalties index) takes the shipped list from
/// there: only `0020` runs, and the block hash indexes exist.
#[tokio::test]
async fn a_file_at_0019_takes_only_0020() {
    let dir = TempDir::new();
    let at = MIGRATIONS
        .iter()
        .position(|(n, _)| *n == "0020_lightning_blocks.sql")
        .unwrap();
    let old = open(&dir.0, MIGRATIONS.get(..at).unwrap()).unwrap();
    assert_eq!(version(&old).await, 19);
    old.close().await;
    let applied = Arc::new(Mutex::new(Vec::new()));
    let seen = applied.clone();
    let options = Options {
        observer: Arc::new(move |e| {
            if let Event::MigrationApplied { name, .. } = e {
                seen.lock().unwrap().push(name.to_string());
            }
        }),
        ..Options::default()
    };
    // The list as it shipped with `0020`: later migrations are not this test's.
    let shipped = MIGRATIONS.get(..=at).unwrap();
    let store = Store::open_with(&dir.0, "regtest", options, shipped).unwrap();
    assert_eq!(*applied.lock().unwrap(), ["0020_lightning_blocks.sql"]);
    assert_eq!(version(&store).await, 20);
    let indexes: Vec<String> = store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'index' \
                     AND name IN ('ln_channels_open_hash', 'ln_channels_close_hash', \
                     'ln_channels_penalties') ORDER BY name",
                )?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?)
        })
        .await
        .unwrap();
    store.close().await;
    assert_eq!(indexes.len(), 3, "{indexes:?}");
}

/// `build.rs` reruns when a migration is added or changed: the compiled-in list is the directory
/// as it is now, names and text. A stale build-script output fails here.
#[test]
fn compiled_migrations_match_the_files() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/store/migrations");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".sql"))
        .map(|n| {
            let text = std::fs::read_to_string(dir.join(&n)).unwrap();
            (n, text)
        })
        .collect();
    files.sort();
    let compiled: Vec<(String, String)> = MIGRATIONS
        .iter()
        .map(|(n, t)| ((*n).to_owned(), (*t).to_owned()))
        .collect();
    assert_eq!(compiled, files);
}

#[tokio::test]
async fn fresh_database_gets_every_migration_and_wal() {
    let dir = TempDir::new();
    let applied = Arc::new(Mutex::new(Vec::new()));
    let seen = applied.clone();
    let options = Options {
        observer: Arc::new(move |e| {
            if let Event::MigrationApplied { name, .. } = e {
                seen.lock().unwrap().push(name.to_string());
            }
        }),
        ..Options::default()
    };
    let store = Store::open_with(&dir.0, "regtest", options, &[M1, M2]).unwrap();
    assert_eq!(*applied.lock().unwrap(), [M1.0, M2.0]);
    assert_eq!(version(&store).await, 2);
    let mode: String = store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("PRAGMA journal_mode")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    assert!(dir.0.join("regtest.sqlite").exists());
    store.close().await;
}

#[tokio::test]
async fn upgrade_applies_only_the_new_migrations() {
    let dir = TempDir::new();
    let store = open(&dir.0, &[M1]).unwrap();
    insert(&store, 7).await;
    store.close().await;

    let applied = Arc::new(AtomicUsize::new(0));
    let seen = applied.clone();
    let options = Options {
        observer: Arc::new(move |_| {
            seen.fetch_add(1, Ordering::Relaxed);
        }),
        ..Options::default()
    };
    let store = Store::open_with(&dir.0, "regtest", options.clone(), &[M1, M2]).unwrap();
    assert_eq!(applied.load(Ordering::Relaxed), 1);
    assert_eq!(version(&store).await, 2);
    assert_eq!(count(&store).await, 1);
    store.close().await;

    // Opening again applies nothing.
    let store = Store::open_with(&dir.0, "regtest", options, &[M1, M2]).unwrap();
    assert_eq!(applied.load(Ordering::Relaxed), 1);
    store.close().await;
}

#[tokio::test]
async fn a_newer_database_is_refused() {
    let dir = TempDir::new();
    open(&dir.0, &[M1, M2]).unwrap().close().await;
    match open(&dir.0, &[M1]) {
        Err(OpenError::TooNew {
            found: 2,
            supported: 1,
        }) => {}
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("opened a newer database"),
    }
}

#[tokio::test]
async fn a_failed_migration_rolls_back_alone() {
    let dir = TempDir::new();
    let bad: Migration = (
        "0002_bad.sql",
        "CREATE TABLE half (x); SELECT * FROM missing;",
    );
    match open(&dir.0, &[M1, bad]) {
        Err(OpenError::Migration {
            name: "0002_bad.sql",
            ..
        }) => {}
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("a broken migration applied"),
    }
    let store = open(&dir.0, &[M1]).unwrap();
    assert_eq!(version(&store).await, 1);
    let half: i64 = store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM sqlite_schema WHERE name = 'half'")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(half, 0);
    store.close().await;
}

#[test]
fn misnumbered_migrations_stop_the_open() {
    let dir = TempDir::new();
    assert!(matches!(
        open(&dir.0, &[M2]),
        Err(OpenError::BadMigrations(_))
    ));
}

#[tokio::test]
async fn a_corrupt_file_is_reported() {
    let dir = TempDir::new();
    std::fs::create_dir_all(&dir.0).unwrap();
    std::fs::write(dir.0.join("regtest.sqlite"), vec![0x5a; 8192]).unwrap();
    assert!(matches!(
        open(&dir.0, &[M1]),
        Err(OpenError::Corrupt { .. })
    ));

    // A real database with a damaged page, past the header.
    let dir = TempDir::new();
    let store = open(&dir.0, &[M1]).unwrap();
    store
        .write(|sql| {
            let mut insert = sql.prepare("INSERT INTO items (label) VALUES (?1)")?;
            for i in 0..2000 {
                insert.execute(params![format!("item {i}")])?;
            }
            Ok(())
        })
        .await
        .unwrap();
    store.close().await;
    let file = dir.0.join("regtest.sqlite");
    let mut bytes = std::fs::read(&file).unwrap();
    assert!(bytes.len() > 3 * 4096);
    bytes[2 * 4096..3 * 4096].fill(0x5a);
    std::fs::write(&file, bytes).unwrap();
    match open(&dir.0, &[M1]) {
        Err(OpenError::Corrupt { .. }) => {}
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("opened a damaged database"),
    }
}

#[test]
fn network_names_cannot_leave_the_directory() {
    let dir = TempDir::new();
    for bad in ["", "../x", "Main", "a/b", "a.b"] {
        assert!(
            matches!(
                Store::open(&dir.0, bad, Options::default()),
                Err(OpenError::BadName)
            ),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn readers_cannot_write() {
    let dir = TempDir::new();
    let store = open(&dir.0, &[M1]).unwrap();
    let result = store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("INSERT INTO items (label) VALUES ('x')")?
                .execute([])?)
        })
        .await;
    match result {
        Err(Error::Sql(e)) => {
            assert_eq!(e.sqlite_error_code(), Some(rusqlite::ErrorCode::ReadOnly))
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(count(&store).await, 0);
    store.close().await;
}

#[tokio::test]
async fn a_failed_or_panicking_write_rolls_back_and_the_writer_survives() {
    let dir = TempDir::new();
    let store = open(&dir.0, &[M1]).unwrap();
    let failed = store
        .write(|sql| {
            sql.prepare("INSERT INTO items (id, label) VALUES (1, 'x')")?
                .execute([])?;
            sql.prepare("INSERT INTO items (id, label) VALUES (1, 'duplicate')")?
                .execute([])?;
            Ok(())
        })
        .await;
    assert!(matches!(failed, Err(Error::Sql(_))));
    let panicked: Result<(), Error> = store
        .write(|sql| -> Result<(), Error> {
            sql.prepare("INSERT INTO items (id, label) VALUES (2, 'x')")?
                .execute([])?;
            panic!("job bug");
        })
        .await;
    assert!(matches!(panicked, Err(Error::Panicked)));
    assert_eq!(count(&store).await, 0);
    insert(&store, 3).await;
    assert_eq!(count(&store).await, 1);
    store.close().await;
}

/// What the observer heard about failing writes: `(kind, detail, failures)`, and recoveries.
type Heard = Arc<Mutex<(Vec<(&'static str, String, u32)>, Vec<u32>)>>;

fn listening(dir: &Path) -> (Store, Heard) {
    let heard = Heard::default();
    let h = heard.clone();
    let observer = move |e: &Event| {
        let mut h = h.lock().unwrap();
        match e {
            Event::WriteFailed {
                kind,
                detail,
                failures,
            } => h.0.push((kind, (*detail).to_owned(), *failures)),
            Event::WriteRecovered { failures } => h.1.push(*failures),
            _ => {}
        }
    };
    let options = Options {
        observer: Arc::new(observer),
        ..Options::default()
    };
    (
        Store::open_with(dir, "regtest", options, &[M1]).unwrap(),
        heard,
    )
}

/// Sets a writer pragma that outlives the write, as a full disk or a read-only mount would.
async fn writer_pragma(store: &Store, sql: &'static str) {
    store
        .write(move |s| {
            let _: Option<i64> = s.prepare(sql)?.query_row([], |r| r.get(0)).optional()?;
            Ok(())
        })
        .await
        .unwrap();
}

async fn insert_big(store: &Store, id: i64) -> Result<(), Error> {
    store
        .write(move |sql| {
            sql.prepare("INSERT INTO items (id, label) VALUES (?1, ?2)")?
                .execute(params![id, "x".repeat(100_000)])?;
            Ok(())
        })
        .await
}

/// A full disk, simulated by capping the file at its current size: SQLite answers exactly as it
/// does when the disk is full (`SQLITE_FULL`). Every failed write counts; the 1st, 2nd, 4th and
/// 8th are reported with SQLite's message; the health says so until a write commits again.
#[tokio::test]
async fn a_full_disk_is_classified_reported_in_powers_of_two_and_recovers() {
    let dir = TempDir::new();
    let (store, heard) = listening(&dir.0);
    assert_eq!(store.write_health(), WriteHealth::default());
    insert(&store, 1).await;
    writer_pragma(&store, "PRAGMA max_page_count = 1").await;
    let ok = store.write_health();
    assert!(ok.last_ok.is_some() && ok.failures == 0 && ok.kind.is_none());

    for i in 0..9 {
        let e = insert_big(&store, 10 + i).await.unwrap_err();
        assert!(matches!(e, Error::Sql(_)), "{e}");
    }
    let h = store.write_health();
    assert_eq!(
        (h.failures, h.kind, h.last_ok),
        (9, Some("disk_full"), ok.last_ok)
    );
    let failed = heard.lock().unwrap().0.clone();
    assert_eq!(
        failed.iter().map(|f| f.2).collect::<Vec<_>>(),
        [1, 2, 4, 8],
        "{failed:?}"
    );
    assert!(failed.iter().all(|f| f.0 == "disk_full"));
    assert_eq!(failed[0].1, "database or disk is full");

    writer_pragma(&store, "PRAGMA max_page_count = 1000000").await;
    assert_eq!(heard.lock().unwrap().1, [9]);
    let h = store.write_health();
    assert!(h.failures == 0 && h.kind.is_none() && h.last_ok > ok.last_ok);
    insert_big(&store, 99).await.unwrap();
    store.close().await;
}

/// Writes refused as on a read-only mount (`query_only` gives SQLite's `SQLITE_READONLY`), and a
/// read-only file classified the same way. A constraint failure is the caller's, not the store's.
#[tokio::test]
async fn read_only_is_classified_and_constraints_are_not_failures() {
    let dir = TempDir::new();
    let (store, heard) = listening(&dir.0);
    insert(&store, 1).await;
    let dup = store
        .write(|sql| {
            sql.prepare("INSERT INTO items (id, label) VALUES (1, 'x')")?
                .execute([])?;
            Ok(())
        })
        .await;
    assert!(matches!(dup, Err(Error::Sql(_))));
    assert_eq!(store.write_health().failures, 0);

    writer_pragma(&store, "PRAGMA query_only = ON").await;
    assert!(insert_big(&store, 2).await.is_err());
    assert_eq!(store.write_health().kind, Some("read_only"));
    let failed = heard.lock().unwrap().0.clone();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].0, "read_only");
    assert!(failed[0].1.contains("readonly"), "{failed:?}");
    store.close().await;

    // The same code from a file the process may not write.
    let file = dir.0.join("regtest.sqlite");
    let conn =
        rusqlite::Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let e = conn
        .execute("INSERT INTO items (id, label) VALUES (5, 'x')", [])
        .unwrap_err();
    assert_eq!(failure_kind(&e), Some("read_only"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_queue_pushes_back() {
    let dir = TempDir::new();
    let options = Options {
        queue: 1,
        ..Options::default()
    };
    let store = Arc::new(Store::open_with(&dir.0, "regtest", options, &[M1]).unwrap());
    let (started_tx, started) = std_mpsc::channel();
    let (release, wait) = std_mpsc::channel::<()>();
    let busy = tokio::spawn({
        let store = store.clone();
        async move {
            store
                .write(move |_| {
                    started_tx.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                })
                .await
        }
    });
    tokio::task::spawn_blocking(move || started.recv().unwrap())
        .await
        .unwrap();
    // The writer is busy; this one fills the queue.
    let queued = tokio::spawn({
        let store = store.clone();
        async move { store.write(|_| Ok(())).await }
    });
    while store.queue_depth() < 1 {
        tokio::task::yield_now().await;
    }
    assert!(matches!(
        store.try_write(|_| Ok(())).await,
        Err(Error::Full)
    ));
    let waiting = tokio::time::timeout(Duration::from_millis(100), store.write(|_| Ok(()))).await;
    assert!(waiting.is_err(), "write did not wait for room");

    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    queued.await.unwrap().unwrap();
    store.write(|_| Ok(())).await.unwrap();
    assert_eq!(store.queue_depth(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readers_answer_while_a_write_is_open() {
    let dir = TempDir::new();
    let store = Arc::new(open(&dir.0, &[M1]).unwrap());
    insert(&store, 1).await;
    let (inserted_tx, inserted) = std_mpsc::channel();
    let (release, wait) = std_mpsc::channel::<()>();
    let write = tokio::spawn({
        let store = store.clone();
        async move {
            store
                .write(move |sql| {
                    let mut insert = sql.prepare("INSERT INTO items (label) VALUES ('bulk')")?;
                    for _ in 0..10_000 {
                        insert.execute([])?;
                    }
                    inserted_tx.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok(())
                })
                .await
        }
    });
    tokio::task::spawn_blocking(move || inserted.recv().unwrap())
        .await
        .unwrap();
    // The write transaction is open with 10,000 rows in it: readers see the last commit.
    for _ in 0..20 {
        assert_eq!(count(&store).await, 1);
    }
    release.send(()).unwrap();
    write.await.unwrap().unwrap();
    assert_eq!(count(&store).await, 10_001);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_read_is_interrupted_and_the_connection_reused() {
    let dir = TempDir::new();
    let timeouts = Arc::new(AtomicUsize::new(0));
    let seen = timeouts.clone();
    let options = Options {
        readers: 1,
        read_time_limit: Duration::from_millis(100),
        observer: Arc::new(move |e| {
            // The event names the read that ran too long.
            if matches!(
                e,
                Event::ReadTimedOut {
                    read: Read::Audit,
                    ..
                }
            ) {
                seen.fetch_add(1, Ordering::Relaxed);
            }
        }),
        ..Options::default()
    };
    let store = Store::open_with(&dir.0, "regtest", options, &[M1]).unwrap();
    let endless = store
        .read(Read::Audit, |sql| {
            Ok(sql
                .prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c")?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
        .await;
    assert!(matches!(endless, Err(Error::TimedOut)), "{endless:?}");
    assert_eq!(timeouts.load(Ordering::Relaxed), 1);
    assert_eq!(count(&store).await, 0);
    store.close().await;
}

const ENDLESS: &str =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";

fn one_reader(limit_ms: u64) -> Options {
    Options {
        readers: 1,
        read_time_limit: Duration::from_millis(limit_ms),
        ..Options::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_time_limit_holds_across_statements() {
    let dir = TempDir::new();
    let store = Store::open_with(&dir.0, "regtest", one_reader(50), &[M1]).unwrap();
    // No statement runs when the limit passes; the next one must still be stopped.
    let late = store
        .read(Read::Blocks, |sql| {
            std::thread::sleep(Duration::from_millis(150));
            Ok(sql
                .prepare(ENDLESS)?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
        .await;
    assert!(matches!(late, Err(Error::TimedOut)), "{late:?}");
    store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_read_still_stops_and_frees_its_connection() {
    let dir = TempDir::new();
    let store = Store::open_with(&dir.0, "regtest", one_reader(100), &[M1]).unwrap();
    let cancelled = tokio::time::timeout(
        Duration::from_millis(20),
        store.read(Read::Blocks, |sql| {
            Ok(sql
                .prepare(ENDLESS)?
                .query_row([], |r| r.get::<_, i64>(0))?)
        }),
    )
    .await;
    assert!(cancelled.is_err());
    // The only connection comes back once the abandoned query hits its limit.
    assert_eq!(count(&store).await, 0);
    store.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_time_limit_stops_many_short_statements() {
    let dir = TempDir::new();
    let store = Store::open_with(&dir.0, "regtest", one_reader(20), &[M1]).unwrap();
    // Each statement is far too short to reach the progress handler on its own.
    let fresh: Result<(), _> = store
        .read(Read::Blocks, |sql| {
            loop {
                sql.prepare("SELECT 1")?
                    .query_row([], |r| r.get::<_, i64>(0))?;
            }
        })
        .await;
    assert!(matches!(fresh, Err(Error::TimedOut)), "{fresh:?}");
    let reused: Result<(), _> = store
        .read(Read::Blocks, |sql| {
            let mut one = sql.prepare("SELECT 1")?;
            loop {
                one.query_row([], |r| r.get::<_, i64>(0))?;
            }
        })
        .await;
    assert!(matches!(reused, Err(Error::TimedOut)), "{reused:?}");
    store.close().await;
}

#[tokio::test]
async fn a_write_cannot_end_its_own_transaction() {
    let dir = TempDir::new();
    let store = open(&dir.0, &[M1]).unwrap();
    for end in ["COMMIT", "END", "ROLLBACK"] {
        let ended = store
            .write(move |sql| {
                sql.prepare("INSERT INTO items (label) VALUES ('x')")?
                    .execute([])?;
                let mut stmt = match end {
                    "COMMIT" => sql.prepare("COMMIT")?,
                    "END" => sql.prepare("END")?,
                    _ => sql.prepare("ROLLBACK")?,
                };
                // Ignore the outcome, as careless code would, and carry on writing.
                let _ = stmt.execute([]);
                let _ = sql
                    .prepare("INSERT INTO items (label) VALUES ('after')")?
                    .execute([]);
                Ok(())
            })
            .await;
        assert!(matches!(ended, Err(Error::Sql(_))), "{end}: {ended:?}");
        assert_eq!(count(&store).await, 0, "{end}");
    }
    // `OR ROLLBACK` ends the transaction without a statement saying so; later rows must not
    // slip through in autocommit, whether the closure then fails or claims success.
    for fail in [true, false] {
        let result = store
            .write(move |sql| {
                sql.prepare("INSERT INTO items (id, label) VALUES (1, 'x')")?
                    .execute([])?;
                let again = sql
                    .prepare("INSERT OR ROLLBACK INTO items (id, label) VALUES (1, 'x')")?
                    .execute([]);
                assert!(again.is_err());
                let _ = sql
                    .prepare("INSERT INTO items (id, label) VALUES (2, 'x')")?
                    .execute([]);
                if fail { Err(Error::Closed) } else { Ok(()) }
            })
            .await;
        assert!(result.is_err(), "{result:?}");
        assert_eq!(count(&store).await, 0, "fail={fail}");
    }
    // Whatever the closure does with the refusal, an error or a panic still rolls back.
    let panicked: Result<(), Error> = store
        .write(|sql| -> Result<(), Error> {
            sql.prepare("INSERT INTO items (label) VALUES ('x')")?
                .execute([])?;
            let _ = sql.prepare("COMMIT");
            panic!("after a refused commit");
        })
        .await;
    assert!(matches!(panicked, Err(Error::Panicked)));
    assert_eq!(count(&store).await, 0);
    // Ending the transaction implicitly and opening a new one must not commit the remainder.
    for begin in ["BEGIN", "SAVEPOINT s"] {
        let replaced = store
            .write(move |sql| {
                sql.prepare("INSERT INTO items (id, label) VALUES (1, 'x')")?
                    .execute([])?;
                let _ = sql
                    .prepare("INSERT OR ROLLBACK INTO items (id, label) VALUES (1, 'x')")?
                    .execute([]);
                if let Ok(mut stmt) = if begin == "BEGIN" {
                    sql.prepare("BEGIN")
                } else {
                    sql.prepare("SAVEPOINT s")
                } {
                    let _ = stmt.execute([]);
                }
                let _ = sql
                    .prepare("INSERT INTO items (id, label) VALUES (2, 'x')")?
                    .execute([]);
                Ok(())
            })
            .await;
        assert!(replaced.is_err(), "{begin}: {replaced:?}");
    }
    assert_eq!(count(&store).await, 0);
    store.close().await;
}

#[tokio::test]
async fn a_migration_cannot_end_its_own_transaction() {
    for sql in [
        "CREATE TABLE a (x); COMMIT; CREATE TABLE b (x);",
        "CREATE TABLE a (x); ROLLBACK;",
        "CREATE TABLE a (x); ROLLBACK; BEGIN IMMEDIATE; CREATE TABLE b (x);",
        "CREATE TABLE a (x); ROLLBACK; SAVEPOINT s; CREATE TABLE b (x);",
    ] {
        let dir = TempDir::new();
        match open(&dir.0, &[M1, ("0002_split.sql", sql)]) {
            Err(OpenError::Migration {
                name: "0002_split.sql",
                ..
            }) => {}
            Err(e) => panic!("{sql}: {e}"),
            Ok(_) => panic!("{sql}: applied"),
        }
        // Not marked applied: the database is still at version 1.
        let store = open(&dir.0, &[M1]).unwrap();
        assert_eq!(version(&store).await, 1, "{sql}");
        store.close().await;
    }
}

#[tokio::test]
async fn a_read_cannot_leave_a_snapshot_open() {
    let dir = TempDir::new();
    let store = Store::open_with(&dir.0, "regtest", one_reader(2000), &[M1]).unwrap();
    store
        .read(Read::Blocks, |sql| {
            sql.prepare("BEGIN")?.execute([])?;
            Ok(sql
                .prepare("SELECT count(*) FROM items")?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
        .await
        .unwrap();
    insert(&store, 1).await;
    assert_eq!(count(&store).await, 1);
    store.close().await;
}

const CHILD_DIR: &str = "ENGINE_STORE_DURABILITY_DIR";

/// Run by `acknowledged_writes_survive_a_kill` in a child process; does nothing on its own.
#[tokio::test]
async fn durability_child() {
    let Some(dir) = std::env::var_os(CHILD_DIR) else {
        return;
    };
    let dir = PathBuf::from(dir);
    let store = open(&dir, &[M1]).unwrap();
    insert(&store, 1).await;
    std::fs::write(dir.join("acked"), "").unwrap();
    let marker = dir.join("inflight");
    let _ = store
        .write(move |sql| {
            sql.prepare("INSERT INTO items (id, label) VALUES (2, 'x')")?
                .execute([])?;
            std::fs::write(marker, "").unwrap();
            std::thread::sleep(Duration::from_secs(600));
            Ok(())
        })
        .await;
}

#[tokio::test]
async fn acknowledged_writes_survive_a_kill() {
    let dir = TempDir::new();
    std::fs::create_dir_all(&dir.0).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "store::tests::durability_child", "--nocapture"])
        .env(CHILD_DIR, &dir.0)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !dir.0.join("inflight").exists() {
        assert!(
            Instant::now() < deadline,
            "child never reached its uncommitted write"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(dir.0.join("acked").exists());
    child.kill().unwrap(); // SIGKILL: no destructors, no checkpoint.
    child.wait().unwrap();

    let store = open(&dir.0, &[M1]).unwrap();
    let ids: Vec<i64> = store
        .read(Read::Blocks, |sql| {
            let mut stmt = sql.prepare("SELECT id FROM items ORDER BY id")?;
            let ids = stmt
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            Ok(ids)
        })
        .await
        .unwrap();
    assert_eq!(ids, [1]);
    store.close().await;
}

/// A block summary's shape: a dozen integer and short text columns, looked up by hash.
const BLOCKS: Migration = (
    "0001_blocks.sql",
    "CREATE TABLE blocks (
        height INTEGER PRIMARY KEY, hash TEXT NOT NULL, time INTEGER NOT NULL,
        tx_count INTEGER NOT NULL, size INTEGER NOT NULL, weight INTEGER NOT NULL,
        fees INTEGER NOT NULL, reward INTEGER NOT NULL, fee_p10 INTEGER NOT NULL,
        fee_median INTEGER NOT NULL, fee_p90 INTEGER NOT NULL, pool TEXT, coinbase_tag TEXT);
     CREATE UNIQUE INDEX blocks_hash ON blocks (hash);",
);

fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

fn block_hash(height: u64) -> String {
    (0..4)
        .map(|i| format!("{:016x}", mix(height * 4 + i)))
        .collect()
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() - 1) as f64 * p) as usize]
}

/// `cargo test --release -p engine -- --ignored --nocapture bulk_insert_benchmark`
// A manual probe: its report is printed for a person to read (LOGGING.md rule 1).
#[allow(clippy::print_stdout)]
#[ignore = "benchmark: run in release with --nocapture"]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_insert_benchmark() {
    const ROWS: u64 = 1_000_000;
    const BATCH: u64 = 10_000;
    let dir = TempDir::new();
    let store = Arc::new(open(&dir.0, &[BLOCKS]).unwrap());
    let committed = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let reader = |range: bool| {
        let (store, committed, done) = (store.clone(), committed.clone(), done.clone());
        tokio::spawn(async move {
            let mut times = Vec::new();
            let mut n = 0u64;
            while !done.load(Ordering::Relaxed) {
                let top = committed.load(Ordering::Relaxed);
                if top == 0 {
                    tokio::task::yield_now().await;
                    continue;
                }
                n += 1;
                let height = (mix(n) % top) as i64;
                let start = Instant::now();
                let found = if range {
                    store
                        .read(Read::Blocks, move |sql| {
                            let mut stmt = sql.prepare(
                                "SELECT height, fees, fee_median FROM blocks
                                 WHERE height BETWEEN ?1 AND ?1 + 99",
                            )?;
                            let rows = stmt.query_map(params![height], |r| r.get::<_, i64>(1))?;
                            Ok(rows.count())
                        })
                        .await
                        .unwrap()
                } else {
                    let hash = block_hash(height as u64);
                    store
                        .read(Read::Blocks, move |sql| {
                            Ok(sql
                                .prepare("SELECT height FROM blocks WHERE hash = ?1")?
                                .query_row(params![hash], |r| r.get::<_, i64>(0))
                                .optional()?
                                .map_or(0, |_| 1))
                        })
                        .await
                        .unwrap()
                };
                times.push(start.elapsed());
                assert!(found > 0);
            }
            times
        })
    };
    let lookups = reader(false);
    let scans = reader(true);

    let start = Instant::now();
    let mut slowest_batch = Duration::ZERO;
    for first in (0..ROWS).step_by(BATCH as usize) {
        let batch_start = Instant::now();
        store
            .write(move |sql| {
                let mut insert = sql.prepare(
                    "INSERT INTO blocks VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                )?;
                for h in first..first + BATCH {
                    let r = (mix(h) >> 1) as i64;
                    insert.execute(params![
                        h as i64,
                        block_hash(h),
                        1_231_006_505 + h as i64 * 600,
                        r % 5000,
                        r % 2_000_000,
                        r % 4_000_000,
                        r % 100_000_000,
                        625_000_000 + r % 100_000_000,
                        r % 10,
                        r % 50,
                        r % 500,
                        ["Foundry USA", "AntPool", "ViaBTC", "F2Pool"][(r % 4) as usize],
                        "/mined by someone/",
                    ])?;
                }
                Ok(())
            })
            .await
            .unwrap();
        slowest_batch = slowest_batch.max(batch_start.elapsed());
        committed.store(first + BATCH, Ordering::Relaxed);
    }
    let elapsed = start.elapsed();
    done.store(true, Ordering::Relaxed);
    let mut lookups = lookups.await.unwrap();
    let mut scans = scans.await.unwrap();
    Arc::into_inner(store).unwrap().close().await;

    let size = std::fs::metadata(dir.0.join("regtest.sqlite"))
        .unwrap()
        .len();
    println!(
        "inserted {ROWS} rows in {elapsed:.2?}: {:.0} rows/s, slowest {BATCH}-row batch {slowest_batch:.2?}, file {:.1} MiB",
        ROWS as f64 / elapsed.as_secs_f64(),
        size as f64 / (1024.0 * 1024.0)
    );
    for (name, times) in [
        ("hash lookup", &mut lookups),
        ("100-row range scan", &mut scans),
    ] {
        times.sort();
        println!(
            "{name} during the insert: {} reads, median {:.2?}, p99 {:.2?}, worst {:.2?}",
            times.len(),
            percentile(times, 0.5),
            percentile(times, 0.99),
            percentile(times, 1.0)
        );
    }
    let start = Instant::now();
    let store = open(&dir.0, &[BLOCKS]).unwrap();
    println!("reopen with quick_check: {:.2?}", start.elapsed());
    store.close().await;
}

const TRACKED: Migration = (
    "0001_tracked.sql",
    "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
     CREATE TABLE blocks (id INTEGER PRIMARY KEY);
     CREATE TABLE audits (id INTEGER PRIMARY KEY,
         item INTEGER REFERENCES items (id) ON DELETE CASCADE);
     CREATE TABLE mempool_history (t INTEGER PRIMARY KEY) WITHOUT ROWID;
     CREATE TABLE log (label TEXT NOT NULL);
     CREATE TRIGGER items_to_blocks AFTER INSERT ON items WHEN NEW.label = 'block'
         BEGIN INSERT INTO blocks (id) VALUES (NEW.id); END;",
);
/// A migration that writes a tracked table.
const SEED: Migration = ("0002_seed.sql", "INSERT INTO blocks (id) VALUES (100);");

async fn run(store: &Store, sql: &'static str) {
    store
        .write(move |s| {
            s.prepare(sql)?.execute([])?;
            Ok(())
        })
        .await
        .unwrap();
}

/// Each tracked table's version, read the moment a write has returned: `None` there would mean
/// the write was still marked open after the caller resumed.
fn versions(store: &Store) -> [u64; 3] {
    [Table::Blocks, Table::Audits, Table::MempoolHistory]
        .map(|t| store.version(&[t]).expect("no write is open"))
}

/// The versions after `write`, as steps from `before`: 1 for a table the write marked.
fn steps(before: [u64; 3], after: [u64; 3]) -> [u64; 3] {
    [0, 1, 2].map(|i| (after[i] - before[i]) / 2)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_write_path_moves_the_version_of_exactly_the_tables_it_writes() {
    let dir = TempDir::new();
    let store = open(&dir.0, &[TRACKED, SEED]).unwrap();
    // The seeding migration wrote `blocks`; nothing else moved.
    assert_eq!(versions(&store), [2, 0, 0]);
    // [blocks, audits, mempool_history]
    let cases: [(&str, &'static str, [u64; 3]); 10] = [
        (
            "an untracked table",
            "INSERT INTO log (label) VALUES ('x')",
            [0, 0, 0],
        ),
        // A trigger's writes are authorized when the statement is prepared, whether or not it
        // fires: the table is marked even here, which costs a recomputation, never a stale answer.
        (
            "a trigger that does not fire",
            "INSERT INTO items (label) VALUES ('x')",
            [1, 0, 0],
        ),
        (
            "a read of a tracked table",
            "INSERT INTO log SELECT id FROM blocks",
            [0, 0, 0],
        ),
        ("an insert", "INSERT INTO blocks (id) VALUES (1)", [1, 0, 0]),
        (
            "an update",
            "UPDATE blocks SET id = 2 WHERE id = 1",
            [1, 0, 0],
        ),
        (
            "a replace",
            "REPLACE INTO blocks (id) VALUES (2)",
            [1, 0, 0],
        ),
        (
            "a table without rowids",
            "INSERT OR REPLACE INTO mempool_history (t) VALUES (1)",
            [0, 0, 1],
        ),
        (
            "a trigger",
            "INSERT INTO items (id, label) VALUES (50, 'block')",
            [1, 0, 0],
        ),
        ("a whole-table delete", "DELETE FROM blocks", [1, 0, 0]),
        (
            "an insert selecting another table",
            "INSERT INTO log SELECT label FROM items",
            [0, 0, 0],
        ),
    ];
    for (what, sql, want) in cases {
        let before = versions(&store);
        run(&store, sql).await;
        assert_eq!(steps(before, versions(&store)), want, "{what}");
    }

    // A foreign key's cascade: deleting an item deletes its audits.
    run(&store, "INSERT INTO audits (id, item) VALUES (1, 50)").await;
    let before = versions(&store);
    run(&store, "DELETE FROM items WHERE id = 50").await;
    assert_eq!(steps(before, versions(&store)), [0, 1, 0], "a cascade");

    // One statement prepared once and run 1,000 times, and a batch over two tables: one step
    // each, however many rows. Statements cannot outlive their write.
    let before = versions(&store);
    store
        .write(|sql| {
            let mut insert = sql.prepare("INSERT INTO blocks (id) VALUES (?1)")?;
            for i in 1_000..2_000 {
                insert.execute(params![i])?;
            }
            sql.prepare("INSERT INTO audits (id) VALUES (7)")?
                .execute([])?;
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(steps(before, versions(&store)), [1, 1, 0], "a batch");
    // The next write prepares its statement again, and moves the version again.
    let before = versions(&store);
    run(&store, "INSERT INTO blocks (id) VALUES (5000)").await;
    assert_eq!(steps(before, versions(&store)), [1, 0, 0], "the next write");

    // A rolled-back write still moves the version: an answer is recomputed, never kept stale.
    let before = versions(&store);
    let failed = store
        .write(|s| {
            s.prepare("INSERT INTO audits (id) VALUES (99)")?
                .execute([])?;
            Err::<(), _>(Error::Full)
        })
        .await;
    assert!(failed.is_err());
    assert_eq!(steps(before, versions(&store)), [0, 1, 0], "a rollback");
    // So does a write that panics.
    let before = versions(&store);
    let panicked: Result<(), Error> = store
        .write(|s| {
            s.prepare("INSERT INTO audits (id) VALUES (98)")?
                .execute([])?;
            panic!("boom")
        })
        .await;
    assert!(matches!(panicked, Err(Error::Panicked)));
    assert_eq!(steps(before, versions(&store)), [0, 1, 0], "a panic");
    // A combined version moves when either table does.
    let both = store.version(&[Table::Blocks, Table::Audits]).unwrap();
    run(&store, "INSERT INTO audits (id) VALUES (8)").await;
    assert_ne!(
        store.version(&[Table::Blocks, Table::Audits]).unwrap(),
        both
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_version_has_moved_by_the_time_a_write_returns() {
    let dir = TempDir::new();
    let store = open(&dir.0, &[TRACKED]).unwrap();
    for i in 0..500 {
        let before = store.version(&[Table::Blocks]).unwrap();
        store
            .write(move |sql| {
                sql.prepare("INSERT INTO blocks (id) VALUES (?1)")?
                    .execute(params![i])?;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            store.version(&[Table::Blocks]),
            Some(before + 2),
            "write {i}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_version_is_none_while_a_write_to_the_table_is_open() {
    let dir = TempDir::new();
    let store = Arc::new(open(&dir.0, &[TRACKED]).unwrap());
    let before = store.version(&[Table::Blocks]).unwrap();
    let (prepared_tx, prepared) = std_mpsc::channel();
    let (release, wait) = std_mpsc::channel::<()>();
    let write = tokio::spawn({
        let store = store.clone();
        async move {
            store
                .write(move |sql| {
                    let mut insert = sql.prepare("INSERT INTO blocks (id) VALUES (7)")?;
                    prepared_tx.send(()).unwrap();
                    wait.recv().unwrap();
                    insert.execute([])?;
                    Ok(())
                })
                .await
        }
    });
    tokio::task::spawn_blocking(move || prepared.recv().unwrap())
        .await
        .unwrap();
    assert_eq!(store.version(&[Table::Blocks]), None);
    assert_eq!(store.version(&[Table::Audits, Table::Blocks]), None);
    assert!(store.version(&[Table::Audits]).is_some());
    release.send(()).unwrap();
    write.await.unwrap().unwrap();
    let after = store.version(&[Table::Blocks]).unwrap();
    assert_ne!(after, before);
    let seen: i64 = store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM blocks")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(seen, 1);
}

fn for_chain(genesis: u8) -> Options {
    Options {
        genesis: Some([genesis; 32]),
        ..Options::default()
    }
}

async fn block_rows(store: &Store) -> i64 {
    store
        .read(Read::Blocks, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM blocks")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap()
}

/// A write of one block row at `height`, as a writer would make it.
async fn write_row(store: &Store, height: i64) -> Result<(), Error> {
    store
        .write(move |sql| {
            sql.prepare(
                "INSERT INTO blocks (height, hash, time, tx_count, size, weight, paying_weight, \
                 fees, subsidy, reward, difficulty, coinbase_tag, payouts) \
                 VALUES (?1, ?2, 0, 1, 1, 4, 0, 0, 0, 0, 1.0, x'', x'')",
            )?
            .execute(params![height, height.to_le_bytes().to_vec()])?;
            Ok(())
        })
        .await
}

#[tokio::test]
async fn writes_wait_for_the_node_and_none_carried_from_another_chain_lands() {
    let dir = TempDir::new();
    let store = Arc::new(Store::open(&dir.0, "regtest", for_chain(1)).unwrap());
    assert_eq!(store.gate(), Gate::Waiting);
    // Not confirmed yet: the write waits, and commits once the gate opens.
    let waiting = tokio::spawn({
        let s = Arc::clone(&store);
        async move { write_row(&s, 1).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiting.is_finished());
    assert_eq!(block_rows(&store).await, 0);
    store.set_gate(Gate::Open);
    waiting.await.unwrap().unwrap();
    assert_eq!(block_rows(&store).await, 1);

    // Found on another chain: writes wait, and those begun meanwhile fail once it is right again.
    store.set_gate(Gate::Held);
    let held = tokio::spawn({
        let s = Arc::clone(&store);
        async move { write_row(&s, 2).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!held.is_finished());
    store.set_gate(Gate::Open);
    assert!(matches!(held.await.unwrap(), Err(Error::Held)));
    write_row(&store, 3).await.unwrap();
    assert_eq!(block_rows(&store).await, 2);

    // A write waiting at start that sees the node found on another chain fails too.
    let other = TempDir::new();
    let gate = Arc::new(Store::open(&other.0, "regtest", for_chain(1)).unwrap());
    let early = tokio::spawn({
        let s = Arc::clone(&gate);
        async move { write_row(&s, 1).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.set_gate(Gate::Held);
    gate.set_gate(Gate::Open);
    assert!(matches!(early.await.unwrap(), Err(Error::Held)));

    // Refused is final, and fails at once.
    gate.set_gate(Gate::Refused);
    gate.set_gate(Gate::Open);
    assert_eq!(gate.gate(), Gate::Refused);
    assert!(matches!(write_row(&gate, 4).await, Err(Error::Held)));
    assert!(matches!(gate.try_write(|_| Ok(())).await, Err(Error::Held)));
}

#[tokio::test]
async fn a_write_queued_before_the_gate_closes_does_not_commit_after() {
    let dir = TempDir::new();
    let store = Arc::new(Store::open(&dir.0, "regtest", for_chain(1)).unwrap());
    store.set_gate(Gate::Open);
    // Hold the writer so the next write is queued, then close the gate before it runs.
    let (go, wait) = std_mpsc::channel::<()>();
    let busy = tokio::spawn({
        let s = Arc::clone(&store);
        async move {
            s.write(move |_| {
                wait.recv().ok();
                Ok(())
            })
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let queued = tokio::spawn({
        let s = Arc::clone(&store);
        async move { write_row(&s, 1).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    store.set_gate(Gate::Held);
    go.send(()).unwrap();
    busy.await.unwrap().unwrap();
    assert!(matches!(queued.await.unwrap(), Err(Error::Held)));
    assert_eq!(block_rows(&store).await, 0);
}

#[tokio::test]
async fn a_file_records_its_chain_and_refuses_another() {
    let dir = TempDir::new();
    let store = Store::open(&dir.0, "regtest", for_chain(1)).unwrap();
    assert!(!store.unstamped());
    store.close().await;
    // The same chain opens; another is refused, naming the file's chain, and the file is left alone.
    Store::open(&dir.0, "regtest", for_chain(1))
        .unwrap()
        .close()
        .await;
    let e = Store::open(&dir.0, "regtest", for_chain(2)).err().unwrap();
    assert!(matches!(e, OpenError::WrongChain { .. }));
    assert!(e.to_string().contains(&"01".repeat(32)), "{e}");
    let again = Store::open(&dir.0, "regtest", for_chain(1)).unwrap();
    assert_eq!(again.gate(), Gate::Waiting);
}

#[tokio::test]
async fn rows_from_before_the_chain_was_recorded_wait_for_a_check() {
    let dir = TempDir::new();
    // A file from before the `chain` table: rows, and no chain recorded.
    let old = Store::open(&dir.0, "regtest", Options::default()).unwrap();
    write_row(&old, 7).await.unwrap();
    old.write(|sql| Ok(sql.prepare("DELETE FROM chain")?.execute([]).map(drop)?))
        .await
        .unwrap();
    old.close().await;
    let store = Store::open(&dir.0, "regtest", for_chain(1)).unwrap();
    assert!(store.unstamped());
    // Any other chain opens it too until it is stamped: the rows are what tell.
    store.stamp().await.unwrap();
    assert!(!store.unstamped());
    store.close().await;
    assert!(Store::open(&dir.0, "regtest", for_chain(2)).is_err());
    assert!(
        !Store::open(&dir.0, "regtest", for_chain(1))
            .unwrap()
            .unstamped()
    );
}

#[tokio::test]
async fn data_read_during_a_hold_is_never_written_whenever_the_write_comes() {
    let dir = TempDir::new();
    let store = Store::open(&dir.0, "regtest", for_chain(1)).unwrap();
    // Read while waiting at start: written once the gate opens.
    let start = store.generation();
    store.set_gate(Gate::Open);
    assert_eq!(store.generation(), start);
    store.write_from(start, |_| Ok(())).await.unwrap();
    // Read during a hold and kept in a caller's own queue: a fresh write after it ends fails.
    store.set_gate(Gate::Held);
    let held = store.generation();
    store.set_gate(Gate::Open);
    assert!(matches!(
        store.write_from(held, |_| Ok(())).await,
        Err(Error::Held)
    ));
    assert!(matches!(
        store.try_write_from(start, |_| Ok(())).await,
        Err(Error::Held)
    ));
    // Read now: written.
    store
        .write_from(store.generation(), |_| Ok(()))
        .await
        .unwrap();
}

/// No query may need a writable temporary directory: the image has none. Every connection, the
/// writer and each reader, keeps SQLite's temporary data in memory (2 is `MEMORY`).
#[tokio::test]
async fn every_connection_keeps_temporary_data_in_memory() {
    let dir = TempDir::new();
    let store = Arc::new(open(&dir.0, &[M1]).unwrap());
    let writer: i64 = store
        .write(|sql| {
            Ok(sql
                .prepare("PRAGMA temp_store")?
                .query_row([], |r| r.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(writer, 2);
    // Every reader at once, so each connection answers, not one reused.
    let readers = Options::default().readers;
    let all = Arc::new(std::sync::Barrier::new(readers));
    let reads = (0..readers).map(|_| {
        let (store, all) = (store.clone(), all.clone());
        tokio::spawn(async move {
            store
                .read(Read::Blocks, move |sql| {
                    all.wait();
                    Ok(sql
                        .prepare("PRAGMA temp_store")?
                        .query_row([], |r| r.get::<_, i64>(0))?)
                })
                .await
                .unwrap()
        })
    });
    for r in reads.collect::<Vec<_>>() {
        assert_eq!(r.await.unwrap(), 2);
    }
}

/// What the observer heard about failing reads: `(read, kind, detail, failures)`, and
/// recoveries.
type HeardReads = Arc<Mutex<(Vec<(Read, &'static str, String, u32)>, Vec<(Read, u32)>)>>;

/// A read that fails in SQLite is reported with its kind and SQLite's message at the 1st, 2nd,
/// 4th and 8th failure of that read in a row, each read counted apart, then its recovery; a
/// panicking read is reported as `panicked`.
#[tokio::test]
async fn failed_reads_are_reported_per_read_in_powers_of_two_and_recover() {
    let dir = TempDir::new();
    let heard = HeardReads::default();
    let h = heard.clone();
    let options = Options {
        observer: Arc::new(move |e: &Event| {
            let mut h = h.lock().unwrap();
            match e {
                Event::ReadFailed {
                    read,
                    kind,
                    detail,
                    failures,
                } => h.0.push((*read, kind, (*detail).to_owned(), *failures)),
                Event::ReadRecovered { read, failures } => h.1.push((*read, *failures)),
                _ => {}
            }
        }),
        ..Options::default()
    };
    let store = Store::open_with(&dir.0, "regtest", options, &[M1]).unwrap();
    let missing = |read| {
        store.read(read, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM gone")?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
    };
    for _ in 0..9 {
        assert!(matches!(
            missing(Read::LightningIndex).await,
            Err(Error::Sql(_))
        ));
    }
    assert!(missing(Read::Audit).await.is_err());
    let failed = heard.lock().unwrap().0.clone();
    let index: Vec<_> = failed
        .iter()
        .filter(|f| f.0 == Read::LightningIndex)
        .map(|f| f.3)
        .collect();
    assert_eq!(index, [1, 2, 4, 8], "{failed:?}");
    assert!(failed.iter().any(|f| f.0 == Read::Audit && f.3 == 1));
    assert!(
        failed
            .iter()
            .all(|f| f.1 == "other" && f.2 == "no such table: gone")
    );
    assert!(heard.lock().unwrap().1.is_empty());

    store
        .read(Read::LightningIndex, |sql| {
            Ok(sql
                .prepare("SELECT count(*) FROM items")?
                .query_row([], |r| r.get::<_, i64>(0))?)
        })
        .await
        .unwrap();
    assert_eq!(heard.lock().unwrap().1, [(Read::LightningIndex, 9)]);

    let panicked = store
        .read(Read::Mining, |_| -> Result<(), Error> { panic!("a bug") })
        .await;
    assert!(matches!(panicked, Err(Error::Panicked)));
    let last = heard.lock().unwrap().0.last().cloned().unwrap();
    assert_eq!(last, (Read::Mining, "panicked", String::new(), 1));
    store.close().await;
}
