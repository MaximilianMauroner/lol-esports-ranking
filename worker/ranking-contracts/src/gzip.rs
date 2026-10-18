use crate::Result;
use flate2::bufread::DeflateDecoder;
use std::io::Read;

/// Validated transport decoding shared with public archive reads. The consumer
/// chooses whether semantic bytes need a tree or only an integrity digest.
pub fn decode_gzip(compressed: &[u8], limit: u64, mut consume: impl FnMut(&[u8])) -> Result<u64> {
    let mut remaining = compressed;
    let mut bytes = 0;
    let mut buffer = [0; 65_536];
    loop {
        let mut member = DeflateDecoder::new(gzip_payload(remaining)?);
        let mut crc = crc32fast::Hasher::new();
        loop {
            let size = member
                .read(&mut buffer)
                .map_err(|_| "State member gzip is corrupt")?;
            if size == 0 {
                break;
            }
            bytes += size as u64;
            if bytes > limit {
                return Err("State member semantic size mismatch".into());
            }
            consume(&buffer[..size]);
            crc.update(&buffer[..size]);
        }
        // Gzip ISIZE is the decoded size modulo 2^32 for this member.
        let member_bytes = member.total_out() as u32;
        let (trailer, rest) = member
            .into_inner()
            .split_at_checked(8)
            .ok_or("State member gzip is corrupt")?;
        let expected_crc = u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);
        let expected_bytes = u32::from_le_bytes([trailer[4], trailer[5], trailer[6], trailer[7]]);
        if crc.finalize() != expected_crc || member_bytes != expected_bytes {
            return Err("State member gzip is corrupt".into());
        }
        remaining = rest;
        // Match Node's concatenated members and zero-padding end marker.
        if remaining.is_empty() || remaining[0] == 0 {
            break;
        }
    }
    Ok(bytes)
}

fn gzip_payload(compressed: &[u8]) -> Result<&[u8]> {
    let error = "State member gzip is corrupt";
    let fixed = compressed.get(..10).ok_or(error)?;
    let flags = fixed[3];
    if fixed[..3] != [0x1f, 0x8b, 8] || flags & 0xe0 != 0 {
        return Err(error.into());
    }
    let mut remaining = &compressed[10..];
    if flags & 4 != 0 {
        let (length, rest) = remaining.split_at_checked(2).ok_or(error)?;
        let extra_bytes = usize::from(u16::from_le_bytes([length[0], length[1]]));
        (_, remaining) = rest.split_at_checked(extra_bytes).ok_or(error)?;
    }
    // Ignore transport labels without allocating or imposing flate2's label cap.
    for flag in [8, 16] {
        if flags & flag != 0 {
            let end = remaining.iter().position(|byte| *byte == 0).ok_or(error)?;
            remaining = &remaining[end + 1..];
        }
    }
    if flags & 2 != 0 {
        let header_bytes = compressed.len() - remaining.len();
        let (checksum, rest) = remaining.split_at_checked(2).ok_or(error)?;
        if u16::from_le_bytes([checksum[0], checksum[1]])
            != crc32fast::hash(&compressed[..header_bytes]) as u16
        {
            return Err(error.into());
        }
        remaining = rest;
    }
    Ok(remaining)
}
