//! Checks on the workspace's own source that clippy cannot express. Each is a test, so `cargo test`
//! and CI's `cargo nextest run` enforce it with the rest of the suite.

#[cfg(test)]
mod clock;
