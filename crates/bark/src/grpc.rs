//! The little of gRPC and protobuf one unary call needs: a message is a flag byte (0, not
//! compressed), a big-endian u32 length and the protobuf bytes. Both the request and the reply
//! hold their payload as field 1, length-delimited (tag 0x0a).

use crate::id::{VtxoId, WIRE_LEN};

/// The request body for `GetVtxo`.
pub fn request(id: &VtxoId) -> Vec<u8> {
    let mut msg = Vec::with_capacity(2 + WIRE_LEN);
    msg.push(0x0a);
    msg.push(WIRE_LEN as u8);
    msg.extend_from_slice(&id.wire());
    let mut body = Vec::with_capacity(5 + msg.len());
    body.push(0);
    body.extend_from_slice(&(msg.len() as u32).to_be_bytes());
    body.extend_from_slice(&msg);
    body
}

fn varint(b: &mut &[u8]) -> Option<u64> {
    let mut n = 0u64;
    for shift in (0..64).step_by(7) {
        let (&byte, rest) = b.split_first()?;
        *b = rest;
        n |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(n);
        }
    }
    None
}

fn take<'a>(b: &mut &'a [u8], n: u64) -> Option<&'a [u8]> {
    let n = usize::try_from(n).ok()?;
    if n > b.len() {
        return None;
    }
    let (head, rest) = b.split_at(n);
    *b = rest;
    Some(head)
}

/// The VTXO bytes in a reply body: exactly one message, its field 1. Other fields are skipped.
pub fn reply(body: &[u8]) -> Option<&[u8]> {
    let (&flag, rest) = body.split_first()?;
    if flag != 0 {
        return None;
    }
    let len: [u8; 4] = rest.get(..4)?.try_into().ok()?;
    let msg = rest.get(4..)?;
    if msg.len() != u32::from_be_bytes(len) as usize {
        return None;
    }
    let mut b = msg;
    let mut found = None;
    while !b.is_empty() {
        let key = varint(&mut b)?;
        let field = key >> 3;
        match key & 7 {
            0 => {
                varint(&mut b)?;
            }
            1 => {
                take(&mut b, 8)?;
            }
            2 => {
                let n = varint(&mut b)?;
                let v = take(&mut b, n)?;
                if field == 1 {
                    found = Some(v);
                }
            }
            5 => {
                take(&mut b, 4)?;
            }
            _ => return None,
        }
    }
    found
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn frames_the_request() {
        let id: VtxoId = format!("{}:2", "ab".repeat(32)).parse().unwrap();
        let r = request(&id);
        assert_eq!(&r[..7], &[0, 0, 0, 0, 38, 0x0a, 36]);
        assert_eq!(r.len(), 5 + 38);
    }

    #[test]
    fn reads_field_one() {
        let mut msg = vec![0x10, 0x96, 0x01, 0x0a, 3, 1, 2, 3, 0x1a, 1, 9];
        let mut body = vec![0];
        body.extend((msg.len() as u32).to_be_bytes());
        body.append(&mut msg);
        assert_eq!(reply(&body), Some(&[1u8, 2, 3][..]));
    }

    #[test]
    fn refuses_bad_frames() {
        assert_eq!(reply(&[]), None);
        assert_eq!(reply(&[1, 0, 0, 0, 0]), None);
        assert_eq!(reply(&[0, 0, 0, 0, 5, 0x0a, 3, 1]), None);
        assert_eq!(reply(&[0, 0, 0, 0, 3, 0x0a, 9, 1]), None);
        assert_eq!(reply(&[0, 0, 0, 0, 0]), None);
        assert_eq!(reply(&[0, 0, 0, 0, 2, 0x0b, 0]), None);
        // A varint that never ends.
        assert_eq!(
            reply(&[
                0, 0, 0, 0, 11, 0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff
            ]),
            None
        );
    }
}
