//! The writer thread, end to end. One test, because the logger is set once per process.
#![allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::panic)]

use std::io::{self, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use logging::{Event, Format, Level, QUEUE_LINES, Settings};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
struct Probe {
    n: usize,
}

impl Event for Probe {
    const NAME: &'static str = "probe";
    const LEVEL: Level = Level::Info;
}

#[derive(Serialize)]
struct Noise {}

impl Event for Noise {
    const NAME: &'static str = "noise";
    const LEVEL: Level = Level::Debug;
}

/// Output that blocks every write while the gate is closed, like a stdout nobody reads.
#[derive(Clone)]
struct Gated {
    open: Arc<(Mutex<bool>, Condvar)>,
    out: Arc<Mutex<Vec<u8>>>,
}

impl Write for Gated {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let (lock, cvar) = &*self.open;
        let _open = cvar
            .wait_while(lock.lock().unwrap(), |open| !*open)
            .unwrap();
        self.out.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn set_gate(g: &Gated, open: bool) {
    *g.open.0.lock().unwrap() = open;
    g.open.1.notify_all();
}

fn lines(g: &Gated) -> Vec<Value> {
    String::from_utf8(g.out.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn filters_levels_never_blocks_and_reports_drops() {
    let gate = Gated {
        open: Arc::new((Mutex::new(true), Condvar::new())),
        out: Arc::new(Mutex::new(Vec::new())),
    };
    let settings = Settings {
        format: Format::Json,
        level: Level::Info,
        max_bytes_per_sec: logging::DEFAULT_MAX_BYTES_PER_SEC,
    };
    assert!(logging::init(settings, gate.clone()));
    assert!(
        !logging::init(settings, io::sink()),
        "second init is refused"
    );

    logging::emit(&Noise {});
    logging::emit(&Probe { n: 0 });
    logging::flush(Duration::from_secs(5));
    let first = lines(&gate);
    assert_eq!(first.len(), 1, "debug is filtered at info: {first:?}");
    assert_eq!(first[0]["event"], "probe");

    // A blocked output: emitting far more than the queue holds returns while the output is still
    // blocked, so an emit that waited for it would hang here.
    set_gate(&gate, false);
    let total = QUEUE_LINES * 3;
    for n in 1..=total {
        logging::emit(&Probe { n });
    }

    set_gate(&gate, true);
    logging::flush(Duration::from_secs(5));
    let all = lines(&gate);
    let written = all.iter().filter(|v| v["event"] == "probe").count() - 1;
    let dropped: Vec<&Value> = all
        .iter()
        .filter(|v| v["event"] == "log_events_dropped")
        .collect();
    assert_eq!(dropped.len(), 1, "one summary once the queue drained");
    assert_eq!(dropped[0]["level"], "warn");
    let count = usize::try_from(dropped[0]["count"].as_u64().unwrap()).unwrap();
    assert!(written >= QUEUE_LINES, "a full queue is kept: {written}");
    assert_eq!(written + count, total, "every event is written or counted");
    assert_eq!(dropped[0]["queue_full"], dropped[0]["count"]);
    assert_eq!(dropped[0]["over_budget"], 0);
    assert_eq!(dropped[0]["events"]["probe"], dropped[0]["count"]);
    // The summary follows the backlog it describes.
    assert_eq!(all.last().unwrap()["event"], "log_events_dropped");

    // A panic becomes one event instead of free text on stderr.
    logging::install_panic_hook();
    let hostile = "boom\n{\"event\":\"forged\"}";
    assert!(std::panic::catch_unwind(|| std::panic::panic_any(hostile.to_owned())).is_err());
    let _ = std::panic::take_hook();
    logging::flush(Duration::from_secs(5));
    let all = lines(&gate);
    let panic = all.last().unwrap();
    assert_eq!(panic["event"], "panic");
    assert_eq!(panic["level"], "error");
    assert_eq!(panic["message"], hostile);
    assert!(panic["location"].as_str().unwrap().contains("writer.rs"));
    assert!(!all.iter().any(|v| v["event"] == "forged"));
}
