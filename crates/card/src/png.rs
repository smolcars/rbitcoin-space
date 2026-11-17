//! PNG, 8-bit RGB, no interlace: the signature, `IHDR`, one `IDAT` and `IEND`, each chunk with
//! its CRC. Rows are left unfiltered: a card is flat colour and anti-aliased edges, which
//! deflate matches across rows better than any filter's differences (about 59 KB against 72 KB
//! for the usual smallest-sum choice). `miniz_oxide` compresses. The same pixels always give the
//! same bytes.

/// Compression level: 9 of miniz's 10. Level 10 saves under 1% and takes about twice as long.
const LEVEL: u8 = 9;

fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (n, slot) in (0u32..).zip(t.iter_mut()) {
            let mut c = n;
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    !bytes.iter().fold(!0u32, |c, &b| {
        table
            .get(usize::from((c as u8) ^ b))
            .map_or(c, |t| t ^ (c >> 8))
    })
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(out.get(start..).unwrap_or_default());
    out.extend_from_slice(&crc.to_be_bytes());
}

#[cfg(test)]
fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (ia, ib, ic) = (i16::from(a), i16::from(b), i16::from(c));
    let pv = ia + ib - ic;
    let (pa, pb, pc) = ((pv - ia).abs(), (pv - ib).abs(), (pv - ic).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// `pixels` is `width` × `height` RGB, row by row.
pub(crate) fn encode(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let stride = width as usize * 3;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in pixels.chunks_exact(stride.max(1)).take(height as usize) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut out = Vec::with_capacity(64 * 1024);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    // 8 bits a channel, colour type 2 (RGB), deflate, adaptive filtering, no interlace.
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(
        &mut out,
        b"IDAT",
        &miniz_oxide::deflate::compress_to_vec_zlib(&raw, LEVEL),
    );
    chunk(&mut out, b"IEND", &[]);
    out
}

/// Width, height and RGB pixels of a PNG as [`encode`] writes it, for the tests.
#[cfg(test)]
#[allow(clippy::indexing_slicing)]
pub(crate) fn decode(png: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let mut at = 8;
    let (mut width, mut height, mut data) = (0u32, 0u32, Vec::new());
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().ok()?) as usize;
        let kind = &png[at + 4..at + 8];
        let body = png.get(at + 8..at + 8 + len)?;
        if crc32(&png[at + 4..at + 8 + len])
            != u32::from_be_bytes(png.get(at + 8 + len..at + 12 + len)?.try_into().ok()?)
        {
            return None;
        }
        match kind {
            b"IHDR" => {
                width = u32::from_be_bytes(body[0..4].try_into().ok()?);
                height = u32::from_be_bytes(body[4..8].try_into().ok()?);
                if body[8..13] != [8, 2, 0, 0, 0] {
                    return None;
                }
            }
            b"IDAT" => data.extend_from_slice(body),
            _ => {}
        }
        at += 12 + len;
    }
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&data).ok()?;
    let stride = width as usize * 3;
    let mut out = vec![0u8; stride * height as usize];
    for y in 0..height as usize {
        let kind = raw[y * (stride + 1)];
        let line = &raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)];
        for i in 0..stride {
            let a = if i >= 3 { out[y * stride + i - 3] } else { 0 };
            let b = if y > 0 { out[(y - 1) * stride + i] } else { 0 };
            let c = if i >= 3 && y > 0 {
                out[(y - 1) * stride + i - 3]
            } else {
                0
            };
            out[y * stride + i] = line[i].wrapping_add(match kind {
                0 => 0,
                1 => a,
                2 => b,
                3 => ((u16::from(a) + u16::from(b)) / 2) as u8,
                4 => paeth(a, b, c),
                _ => return None,
            });
        }
    }
    Some((width, height, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_is_the_standard_one() {
        assert_eq!(crc32(b"IEND"), 0xae42_6082);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn pixels_survive_the_round_trip() {
        let pixels: Vec<u8> = (0..7 * 5 * 3).map(|i| (i * 37 % 251) as u8).collect();
        let png = encode(7, 5, &pixels);
        assert_eq!(decode(&png), Some((7, 5, pixels)));
    }
}
