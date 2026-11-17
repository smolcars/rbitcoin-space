//! Numbers and times as the site writes them (`web/src/lib/format.ts`), in integer arithmetic
//! where the site's rule is decimal, so a card and the page it opens agree digit for digit.

/// The narrow no-break space digit groups are joined with.
pub(crate) const NNBSP: char = '\u{202f}';
/// Shown where a figure is not known.
pub(crate) const MISSING: &str = "–";

const SATS_PER_BTC: u64 = 100_000_000;
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Digits in threes: `975411` → `975 411`, as `groupDigits`.
pub(crate) fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() * 2);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(NNBSP);
        }
        out.push(c);
    }
    out
}

/// An exact amount in BTC, as `btcParts`: the grouped whole, the point and the fraction up to
/// its last non-zero digit, then the trailing zeros that complete eight decimals, set apart so
/// they can be dimmed.
pub(crate) fn exact_btc(sats: u64) -> (String, String) {
    let fraction = format!("{:08}", sats % SATS_PER_BTC);
    let significant = fraction.trim_end_matches('0');
    let zeros = fraction.get(significant.len()..).unwrap_or_default();
    (
        format!("{}.{significant}", group(sats / SATS_PER_BTC)),
        zeros.to_owned(),
    )
}

/// `n` divided by `d`, rounded half up. `d` is never zero here.
fn round_div(n: u128, d: u128) -> u128 {
    (2 * n + d) / (2 * d).max(1)
}

/// BTC to a summary's precision, as `formatBtcShort`: whole bitcoins from 1 000, two decimals
/// from 1, three significant digits below.
pub(crate) fn short_btc(sats: u64) -> String {
    let s = u128::from(sats);
    if s == 0 {
        return "0".into();
    }
    // 999.5 BTC and 0.9995 BTC, in sats.
    if s >= 99_950_000_000 {
        let whole = round_div(s, u128::from(SATS_PER_BTC));
        return group(u64::try_from(whole).unwrap_or(u64::MAX));
    }
    let decimals: u32 = if s >= 99_950_000 {
        2
    } else {
        // Three significant digits: 2 − ⌊log10(btc)⌋ decimals, at most eight.
        let digits = s.to_string().len();
        u32::try_from(8 + 3 - digits).unwrap_or(8).min(8)
    };
    let scaled = round_div(s, 10u128.pow(8 - decimals));
    let unit = 10u128.pow(decimals);
    let (whole, fraction) = (scaled / unit, scaled % unit);
    format!("{whole}.{fraction:0width$}", width = decimals as usize)
}

/// A rate in sat/vB, as `formatFeeRate` writes it: two decimals under 10, one under 100,
/// grouped and whole above. `hundredths` and `tenths` are the rate already rounded half up.
fn rate_text(hundredths: u128, tenths: u128, whole: u128) -> String {
    if hundredths < 1000 {
        format!("{}.{:02}", hundredths / 100, hundredths % 100)
    } else if tenths < 1000 {
        format!("{}.{}", tenths / 10, tenths % 10)
    } else {
        group(u64::try_from(whole).unwrap_or(u64::MAX))
    }
}

/// A fee over a virtual size, written as a rate. `None` for no size.
pub(crate) fn fee_rate(fee: u64, vsize: u64) -> Option<String> {
    let (f, v) = (u128::from(fee), u128::from(vsize));
    (v > 0).then(|| rate_text(round_div(f * 100, v), round_div(f * 10, v), round_div(f, v)))
}

/// A rate already in sat/vB, as the block table holds a median. Cut to twelve significant
/// digits before rounding, as `roundScaled` does, so 1.005 does not round down.
pub(crate) fn rate(r: f64) -> String {
    if !r.is_finite() || r < 0.0 {
        return MISSING.into();
    }
    let scaled = |d: i32| -> u128 {
        let x = r * 10f64.powi(d);
        let cut: f64 = format!("{x:.11e}").parse().unwrap_or(x);
        // Saturates: no real rate comes near u128's range.
        cut.round() as u128
    };
    rate_text(scaled(2), scaled(1), scaled(0))
}

/// The fee band, 1 to 12, of a rate as written: the colour always agrees with the number.
pub(crate) fn band(written: &str) -> u8 {
    const BOUNDS: [f64; 11] = [0.12, 0.15, 0.2, 0.3, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0];
    let digits: String = written.chars().filter(|c| *c != NNBSP).collect();
    let Ok(v) = digits.parse::<f64>() else {
        return 1;
    };
    let below = BOUNDS.iter().position(|b| v < *b).unwrap_or(BOUNDS.len());
    u8::try_from(below + 1).unwrap_or(12)
}

/// A virtual size, as `formatSize`: the number and its unit apart. Grouped under 10 000, then
/// thousands and millions with two decimals.
pub(crate) fn size(vb: u64) -> (String, &'static str) {
    let v = u128::from(vb);
    if v < 10_000 {
        return (group(vb), "vB");
    }
    let kilo = round_div(v, 10);
    if kilo < 100_000 {
        return (format!("{}.{:02}", kilo / 100, kilo % 100), "kvB");
    }
    let mega = round_div(v, 10_000);
    let whole = u64::try_from(mega / 100).unwrap_or(u64::MAX);
    (format!("{}.{:02}", group(whole), mega % 100), "MvB")
}

/// Virtual size from weight: a quarter, rounded up, as Core counts it.
pub(crate) fn vsize(weight: u64) -> u64 {
    weight.div_ceil(4)
}

/// `8 hex digits…8 hex digits`, as `truncateMiddle`.
pub(crate) fn short_id(hex: &str) -> String {
    match (hex.get(..8), hex.get(hex.len().saturating_sub(8)..)) {
        (Some(head), Some(tail)) if hex.len() > 17 => format!("{head}…{tail}"),
        _ => hex.to_owned(),
    }
}

/// A UTC calendar day and time from Unix seconds.
struct Utc {
    year: i64,
    month: usize,
    day: u32,
    hour: u64,
    minute: u64,
}

fn utc(unix: u64) -> Utc {
    let days = i64::try_from(unix / 86_400).unwrap_or(i64::MAX / 2);
    let secs = unix % 86_400;
    // Howard Hinnant's days-to-civil, for the proleptic Gregorian calendar.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = usize::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    let year = yoe + era * 400 + i64::from(month <= 2);
    Utc {
        year,
        month,
        day,
        hour: secs / 3600,
        minute: secs % 3600 / 60,
    }
}

/// `17 Nov 2026`
pub(crate) fn day(unix: u64) -> String {
    let t = utc(unix);
    let month = MONTHS.get(t.month.wrapping_sub(1)).unwrap_or(&"");
    format!("{} {month} {}", t.day, t.year)
}

/// `00:29 UTC`
pub(crate) fn clock(unix: u64) -> String {
    let t = utc(unix);
    format!("{:02}:{:02} UTC", t.hour, t.minute)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_are_written_as_the_site_writes_them() {
        assert_eq!(group(0), "0");
        assert_eq!(group(976_200), "976\u{202f}200");
        assert_eq!(exact_btc(55_225_910), ("0.5522591".into(), "0".into()));
        assert_eq!(exact_btc(86_322_454), ("0.86322454".into(), String::new()));
        assert_eq!(exact_btc(0), ("0.".into(), "00000000".into()));
        assert_eq!(exact_btc(100_000_000), ("1.".into(), "00000000".into()));
        assert_eq!(
            exact_btc(u64::MAX),
            (
                "184\u{202f}467\u{202f}440\u{202f}737.09551615".into(),
                String::new()
            )
        );
        assert_eq!(short_btc(0), "0");
        assert_eq!(short_btc(2_650_903), "0.0265");
        assert_eq!(short_btc(149_000), "0.00149");
        assert_eq!(short_btc(1), "0.00000001");
        assert_eq!(short_btc(315_150_903), "3.15");
        assert_eq!(short_btc(99_949_999), "0.999");
        assert_eq!(short_btc(99_950_000), "1.00");
        assert_eq!(short_btc(279_900_000_000), "2\u{202f}799");
        assert_eq!(short_btc(u64::MAX), "184\u{202f}467\u{202f}440\u{202f}737");
    }

    #[test]
    fn rates_and_sizes_are_written_as_the_site_writes_them() {
        assert_eq!(fee_rate(28_200, 141).as_deref(), Some("200"));
        assert_eq!(fee_rate(423, 141).as_deref(), Some("3.00"));
        assert_eq!(fee_rate(1, 3).as_deref(), Some("0.33"));
        assert_eq!(fee_rate(9_996, 1000).as_deref(), Some("10.0"));
        assert_eq!(fee_rate(0, 141).as_deref(), Some("0.00"));
        assert_eq!(fee_rate(1, 0), None);
        assert_eq!(
            fee_rate(u64::MAX, 1).as_deref(),
            Some("18\u{202f}446\u{202f}744\u{202f}073\u{202f}709\u{202f}551\u{202f}615")
        );
        assert_eq!(rate(2.0112), "2.01");
        assert_eq!(rate(1.005), "1.01");
        assert_eq!(rate(1391.6), "1\u{202f}392");
        assert_eq!(rate(f64::NAN), MISSING);
        assert_eq!(band("0.11"), 1);
        assert_eq!(band("0.12"), 2);
        assert_eq!(band("2.01"), 9);
        assert_eq!(band("3.00"), 10);
        assert_eq!(band("200"), 12);
        assert_eq!(band("1\u{202f}392"), 12);
        assert_eq!(size(141), ("141".into(), "vB"));
        assert_eq!(size(9_999), ("9\u{202f}999".into(), "vB"));
        assert_eq!(size(14_620), ("14.62".into(), "kvB"));
        assert_eq!(size(25_455_248), ("25.46".into(), "MvB"));
        assert_eq!(vsize(561), 141);
        assert_eq!(vsize(0), 0);
        assert_eq!(
            short_id("4a705c0b4a53b3b9991663d5adae4959d67841d12b9a1ef3666934518c42e459"),
            "4a705c0b…8c42e459"
        );
    }

    #[test]
    fn times_are_utc() {
        assert_eq!(day(1_794_875_390), "17 Nov 2026");
        assert_eq!(clock(1_794_875_390), "00:29 UTC");
        assert_eq!(day(0), "1 Jan 1970");
        assert_eq!(day(951_782_400), "29 Feb 2000");
        assert_eq!(clock(86_399), "23:59 UTC");
        // The largest header time, u32::MAX.
        assert_eq!(day(4_294_967_295), "7 Feb 2106");
        assert!(!day(u64::MAX).is_empty());
    }
}
