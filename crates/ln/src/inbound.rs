//! lnd's inbound fee, read from the extra data at the end of a `channel_update`, which LDK keeps
//! but does not decode. Gossip is attacker-controlled: every read is bounded, and anything
//! malformed is "no inbound fee", never an error or a panic.
//!
//! The encoding, from lnd's source (`lightningnetwork/lnd` at commit 46f8dc0a, MIT):
//! - `lnwire/channel_update.go`, `ChannelUpdate1.Decode`: the bytes after `htlc_maximum_msat` are
//!   a TLV stream (`ExtraOpaqueData.ExtractRecords`, the P2P decoding), and
//!   `InboundFee tlv.OptionalRecordT[tlv.TlvType55555, Fee]` is the record of type 55555.
//! - `lnwire/typed_fee.go`, `feeDecoder`: its length must be exactly 8, `BaseFee int32` then
//!   `FeeRate int32`, each a big-endian `uint32` cast to signed.
//! - `tlv/stream.go`, `Stream.decode`, and `tlv/varint.go`, `ReadVarInt`: types and lengths are
//!   BigSize, refused when not minimally encoded; types strictly increase (a repeat or a smaller
//!   one fails the stream); unknown records are skipped; a record running past the end fails.
//!
//! lnd drops the whole stream, and so the fee, when any record of it is malformed: so do we.

/// The record type of the inbound fee.
const INBOUND_FEE: u64 = 55_555;

/// A BigSize integer off the front of `b`, minimally encoded.
fn big_size(b: &mut &[u8]) -> Option<u64> {
    let (&first, rest) = b.split_first()?;
    let (v, rest) = match first {
        0xfd => {
            let (n, rest) = rest.split_first_chunk::<2>()?;
            (u64::from(u16::from_be_bytes(*n)), rest)
        }
        0xfe => {
            let (n, rest) = rest.split_first_chunk::<4>()?;
            (u64::from(u32::from_be_bytes(*n)), rest)
        }
        0xff => {
            let (n, rest) = rest.split_first_chunk::<8>()?;
            (u64::from_be_bytes(*n), rest)
        }
        v => (u64::from(v), rest),
    };
    let least = match first {
        0xfd => 0xfd,
        0xfe => 0x1_0000,
        0xff => 0x1_0000_0000,
        _ => 0,
    };
    *b = rest;
    (v >= least).then_some(v)
}

/// The inbound fee in a `channel_update`'s extra data, as `(base fee msat, fee rate ppm)`, both
/// signed (a discount is negative). `None` when there is none or the stream is malformed.
pub fn inbound_fee(extra: &[u8]) -> Option<(i32, i32)> {
    let mut rest = extra;
    // The lowest type the next record may have; `None` once a type of `u64::MAX` was read.
    let mut lowest = Some(0u64);
    let mut fee = None;
    while !rest.is_empty() {
        let kind = big_size(&mut rest)?;
        if lowest.is_none_or(|l| kind < l) {
            return None;
        }
        lowest = kind.checked_add(1);
        let len = usize::try_from(big_size(&mut rest)?).ok()?;
        let value = rest.get(..len)?;
        rest = rest.get(len..)?;
        if kind == INBOUND_FEE {
            let (base, rate) = <&[u8; 8]>::try_from(value).ok()?.split_at(4);
            let int = |b: &[u8]| Some(i32::from_be_bytes(b.try_into().ok()?));
            fee = Some((int(base)?, int(rate)?));
        }
    }
    fee
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing)]

    use lightning::ln::msgs::ChannelUpdate;
    use lightning::util::ser::LengthReadable;

    use super::*;

    /// The record itself: type 55555 (`fd d9 03`), length 8, base then rate.
    fn fee(base: i32, rate: i32) -> Vec<u8> {
        let mut v = vec![0xfd, 0xd9, 0x03, 8];
        v.extend(base.to_be_bytes());
        v.extend(rate.to_be_bytes());
        v
    }

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.split_whitespace().collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// A real mainnet update that carries the field, the one node two of 947085x2207x1 sent, as
    /// LDK kept it in the graph on 2026-11-13: decoded by LDK, its extra data by us.
    #[test]
    fn a_recorded_mainnet_update_carries_its_inbound_fee() {
        let raw = hex(include_str!(
            "../../../fixtures/lightning/channel_update_inbound_fee.hex"
        ));
        let update = ChannelUpdate::read_from_fixed_length_buffer(&mut &raw[..]).unwrap();
        let extra = &update.contents.excess_data;
        assert_eq!(inbound_fee(extra), Some(FIXTURE_FEE));
    }

    /// What the fixture's update says, read by hand from its last 12 bytes
    /// (`fdd903 08 fffffc18 fffffea2`).
    const FIXTURE_FEE: (i32, i32) = (-1_000, -350);

    #[test]
    fn the_record_alone_and_among_unknown_records_is_read() {
        assert_eq!(inbound_fee(&fee(-1_000, -250)), Some((-1_000, -250)));
        assert_eq!(inbound_fee(&fee(0, 0)), Some((0, 0)));
        assert_eq!(
            inbound_fee(&fee(i32::MIN, i32::MAX)),
            Some((i32::MIN, i32::MAX))
        );
        // Unknown records before (type 1, odd; type 2, even) and after (type 55557; a 0xff type).
        let mut v = vec![1, 2, 0xaa, 0xbb, 2, 0];
        v.extend(fee(5, -7));
        v.extend([0xfd, 0xd9, 0x05, 1, 0]);
        v.extend([0xff, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
        assert_eq!(inbound_fee(&v), Some((5, -7)));
        // A record of type u64::MAX ends the stream; nothing may follow it.
        let mut last = fee(1, 1);
        last.extend([0xff; 9]);
        last.push(0);
        assert_eq!(inbound_fee(&last), Some((1, 1)));
    }

    #[test]
    fn absent_or_malformed_is_none() {
        let good = fee(-1_000, -250);
        assert_eq!(inbound_fee(&[]), None);
        // Other records only.
        assert_eq!(inbound_fee(&[1, 1, 0]), None);
        // Cut anywhere.
        for n in 1..good.len() {
            assert_eq!(inbound_fee(&good[..n]), None, "cut at {n}");
        }
        // A length other than 8, shorter or longer, with the bytes there.
        for len in [0u8, 4, 7, 9, 16] {
            let mut v = vec![0xfd, 0xd9, 0x03, len];
            v.extend(std::iter::repeat_n(0, usize::from(len)));
            assert_eq!(inbound_fee(&v), None, "length {len}");
        }
        // Lengths past the end, up to the largest BigSize.
        for len in [
            vec![0xfd, 0xff, 0xff],
            vec![0xfe, 0xff, 0xff, 0xff, 0xff],
            vec![0xff; 9],
        ] {
            let mut v = vec![0xfd, 0xd9, 0x03];
            v.extend(len);
            v.extend([0; 8]);
            assert_eq!(inbound_fee(&v), None);
        }
        // A huge unknown record before it whose length overruns the data.
        let mut huge = vec![1, 0xfe, 0x00, 0x10, 0x00, 0x00];
        huge.extend([0; 1_000]);
        huge.extend(&good);
        assert_eq!(inbound_fee(&huge), None);
        // Wrong order: a smaller type after it, a repeat of it, a type after u64::MAX.
        let mut after = good.clone();
        after.extend([1, 0]);
        assert_eq!(inbound_fee(&after), None);
        let mut twice = good.clone();
        twice.extend(&good);
        assert_eq!(inbound_fee(&twice), None);
        let mut past_max = vec![0xff; 9];
        past_max.push(0);
        past_max.extend([0xff; 9]);
        past_max.push(0);
        assert_eq!(inbound_fee(&past_max), None);
        // A type or a length not minimally encoded.
        let mut wide = vec![0xfe, 0x00, 0x00, 0xd9, 0x03, 8];
        wide.extend([0; 8]);
        assert_eq!(inbound_fee(&wide), None);
        let mut wide_len = vec![0xfd, 0xd9, 0x03, 0xfd, 0x00, 0x08];
        wide_len.extend([0; 8]);
        assert_eq!(inbound_fee(&wide_len), None);
    }

    /// Any bytes at all: no panic, and the answer comes in one pass.
    #[test]
    fn arbitrary_bytes_never_panic() {
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        for n in 0..20_000 {
            let len = n % 64;
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    // Lean towards the bytes that open a BigSize and the record's own type.
                    match seed % 8 {
                        0 => 0xfd,
                        1 => 0xd9,
                        2 => 0x03,
                        3 => 8,
                        _ => (seed >> 8) as u8,
                    }
                })
                .collect();
            let _ = inbound_fee(&bytes);
        }
    }
}
