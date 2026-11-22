use std::fmt;

use hyper::StatusCode;

/// Longest upstream error text we keep. The node's messages are one line.
const MAX_MESSAGE: usize = 512;

/// What went wrong with an Esplora call, in terms a caller can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The URL given to [`Esplora::new`](super::Esplora::new) is not usable.
    Config(&'static str),
    /// 404: no such object, or a bad `?asof=` block.
    NotFound,
    /// 503 `scripthash index disabled`: the node runs without `--sh-index`.
    AddressIndexDisabled,
    /// 503 from `--max-sh-creates`: the unpaged answer is too large. Use a paged route.
    TooLarge,
    /// 503 `chain view moved`, or two stamps of one read disagreed. Retry the read.
    ChainViewMoved,
    /// Another 4xx: the node refused the request. `message` is the node's text,
    /// for example a broadcast reject reason. It is chain-adjacent, untrusted text.
    Rejected { status: StatusCode, message: String },
    /// Connection failure, or a 5xx not covered above.
    Unavailable(String),
    /// The request did not complete within the configured timeout.
    Timeout,
    /// The response body exceeded the configured size cap.
    ResponseTooBig,
    /// The response did not decode into the expected type.
    Decode(String),
    /// An `/internal/*` route was called on a TCP endpoint; they exist only on a unix socket.
    InternalUnavailable,
}

impl Error {
    /// A fixed label for the log: never the node's own text, which can carry chain data.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Unavailable(_) => "unavailable",
            Self::Rejected { .. } => "refused",
            Self::NotFound => "not_found",
            Self::Decode(_) => "malformed",
            Self::TooLarge | Self::ResponseTooBig => "too_big",
            Self::ChainViewMoved => "chain_moved",
            Self::Config(_) | Self::AddressIndexDisabled | Self::InternalUnavailable => "config",
        }
    }

    /// Maps a non-200 upstream answer to an error.
    pub fn from_status(status: StatusCode, body: &[u8]) -> Self {
        let message = message(body);
        match status {
            StatusCode::NOT_FOUND => Self::NotFound,
            StatusCode::SERVICE_UNAVAILABLE => {
                if message.starts_with("scripthash index disabled") {
                    Self::AddressIndexDisabled
                } else if message.contains("--max-sh-creates") {
                    Self::TooLarge
                } else if message == "chain view moved" {
                    Self::ChainViewMoved
                } else {
                    Self::Unavailable(format!("{status}: {message}"))
                }
            }
            s if s.is_client_error() => Self::Rejected { status, message },
            _ => Self::Unavailable(format!("{status}: {message}")),
        }
    }
}

/// How many transactions have paid a script and the node's cap, from its refusal of an unpaged
/// answer for size: `scripthash join exceeds --max-sh-creates (<creates> creates, cap <cap>)`.
/// A create is one transaction paying the script, counted once however many of its outputs do:
/// rbitcoin's index keeps one transaction key per create (`SCHEMA.md`, "Class B — scripthash").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptSize {
    pub creates: u64,
    pub cap: u64,
}

impl ScriptSize {
    /// Read from the node's refusal body. `None` unless the message has exactly that shape, with
    /// plain decimal counts that fit a `u64` and more creates than the cap: the node's wording is
    /// not a contract, so any other shape means "not known", never a guess.
    pub fn from_refusal(body: &[u8]) -> Option<Self> {
        let message = message(body);
        let rest = message.strip_prefix("scripthash join exceeds --max-sh-creates (")?;
        let (creates, cap) = rest.strip_suffix(')')?.split_once(" creates, cap ")?;
        let number = |s: &str| {
            (!s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()))
                .then(|| s.parse::<u64>().ok())
                .flatten()
        };
        let (creates, cap) = (number(creates)?, number(cap)?);
        (creates > cap).then_some(Self { creates, cap })
    }
}

fn message(body: &[u8]) -> String {
    let body = body.get(..MAX_MESSAGE).unwrap_or(body);
    String::from_utf8_lossy(body).trim().to_owned()
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(m) => write!(f, "invalid esplora endpoint: {m}"),
            Self::NotFound => f.write_str("not found"),
            Self::AddressIndexDisabled => f.write_str("address index disabled on the node"),
            Self::TooLarge => f.write_str("history too large for an unpaged answer"),
            Self::ChainViewMoved => f.write_str("chain view moved"),
            Self::Rejected { status, message } => write!(f, "rejected ({status}): {message}"),
            Self::Unavailable(m) => write!(f, "esplora unavailable: {m}"),
            Self::Timeout => f.write_str("esplora request timed out"),
            Self::ResponseTooBig => f.write_str("esplora response too big"),
            Self::Decode(m) => write!(f, "esplora response did not decode: {m}"),
            Self::InternalUnavailable => f.write_str("internal routes need a unix-socket endpoint"),
        }
    }
}

impl std::error::Error for Error {}

impl From<crate::http::Error> for Error {
    fn from(e: crate::http::Error) -> Self {
        use crate::http::Error as H;
        match e {
            H::Config(m) => Self::Config(m),
            H::Unavailable(m) => Self::Unavailable(m),
            H::Timeout => Self::Timeout,
            H::ResponseTooBig => Self::ResponseTooBig,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ScriptSize;

    #[test]
    fn the_size_is_read_from_the_refusal_only_when_it_has_its_exact_shape() {
        let size = |s: &str| ScriptSize::from_refusal(s.as_bytes());
        assert_eq!(
            size("scripthash join exceeds --max-sh-creates (3665660 creates, cap 10000)"),
            Some(ScriptSize {
                creates: 3_665_660,
                cap: 10_000
            })
        );
        // Surrounding whitespace is the transport's, not the message's.
        assert!(
            size("  scripthash join exceeds --max-sh-creates (10001 creates, cap 10000)\n")
                .is_some()
        );
        for changed in [
            "",
            "scripthash join exceeds --max-sh-creates",
            "too many rows; raise --max-sh-creates",
            "scripthash join exceeds --max-sh-creates (3665660 creates)",
            "scripthash join exceeds --max-sh-creates (cap 10000, 3665660 creates)",
            "scripthash join exceeds --max-sh-creates (3,665,660 creates, cap 10,000)",
            "scripthash join exceeds --max-sh-creates (3665660 creates, cap 10000) and more",
            "scripthash join exceeds --max-sh-creates (+3665660 creates, cap 10000)",
            "scripthash join exceeds --max-sh-creates (-1 creates, cap 10000)",
            "scripthash join exceeds --max-sh-creates (1e9 creates, cap 10000)",
            "scripthash join exceeds --max-sh-creates ( creates, cap 10000)",
            "scripthash join exceeds --max-sh-creates (99999999999999999999999 creates, cap 10000)",
            "scripthash join exceeds --max-sh-creates (\u{663}\u{663} creates, cap 1)",
            // Not above the cap: the message contradicts itself.
            "scripthash join exceeds --max-sh-creates (10000 creates, cap 10000)",
            "scripthash join exceeds --max-sh-creates (5 creates, cap 10000)",
        ] {
            assert_eq!(size(changed), None, "{changed:?}");
        }
        // Hostile bytes: invalid UTF-8, a NUL, a body far past the length kept.
        assert_eq!(ScriptSize::from_refusal(&[0xff, 0xfe, b'(']), None);
        assert_eq!(
            size("scripthash join exceeds --max-sh-creates (\x002 creates, cap 1)"),
            None
        );
        let long = format!(
            "scripthash join exceeds --max-sh-creates ({} creates, cap 1)",
            "9".repeat(4096)
        );
        assert_eq!(size(&long), None);
    }
}
