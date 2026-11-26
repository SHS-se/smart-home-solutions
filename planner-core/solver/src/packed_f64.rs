//! Exact little-endian Float64 checkpoint transport. No decimal conversions.
use serde::{Deserialize, Deserializer, Serializer};
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn serialize<S: Serializer>(values: &[f64], serializer: S) -> Result<S::Ok, S::Error> {
    let mut out = Vec::with_capacity((values.len() * 8).div_ceil(3) * 4);
    let (mut accumulator, mut bits) = (0u32, 0usize);
    for value in values {
        if !value.is_finite() {
            return Err(serde::ser::Error::custom(
                "Non-finite numerical accumulator",
            ));
        }
        for byte in value.to_le_bytes() {
            accumulator = (accumulator << 8) | byte as u32;
            bits += 8;
            while bits >= 6 {
                bits -= 6;
                out.push(ALPHABET[((accumulator >> bits) & 63) as usize]);
            }
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((accumulator << (6 - bits)) & 63) as usize]);
    }
    while out.len() % 4 != 0 {
        out.push(b'=');
    }
    serializer.serialize_str(std::str::from_utf8(&out).unwrap())
}
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<f64>, D::Error> {
    let text = String::deserialize(deserializer)?;
    let fail = || serde::de::Error::custom("Invalid packed Float64 accumulator");
    if text.len() % 4 != 0 {
        return Err(fail());
    }
    let mut values = Vec::with_capacity(text.len() / 4 * 3 / 8);
    let (mut accumulator, mut bits, mut used, mut padding) = (0u32, 0usize, 0usize, 0usize);
    let mut bytes = [0u8; 8];
    for byte in text.bytes() {
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return Err(fail());
        }
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(fail()),
        };
        accumulator = (accumulator << 6) | digit as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes[used] = (accumulator >> bits) as u8;
            used += 1;
            if used == 8 {
                let value = f64::from_le_bytes(bytes);
                if !value.is_finite() {
                    return Err(fail());
                }
                values.push(value);
                used = 0;
            }
        }
    }
    if used != 0
        || padding > 2
        || bits != padding * 2
        || (bits > 0 && accumulator & ((1 << bits) - 1) != 0)
    {
        return Err(fail());
    }
    Ok(values)
}
#[cfg(test)]
mod tests {
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Checkpoint {
        #[serde(with = "super")]
        values: Vec<f64>,
    }
    #[test]
    fn checkpoint_roundtrip_preserves_every_finite_float_bit() {
        let mut values = vec![0., -0., f64::MIN_POSITIVE, f64::MAX, f64::from_bits(1)];
        let mut bits = 7u64;
        for _ in 0..10000 {
            bits = bits.wrapping_mul(6364136223846793005).wrapping_add(1);
            let value = f64::from_bits(bits);
            if value.is_finite() {
                values.push(value);
            }
        }
        let encoded = serde_json::to_string(&Checkpoint {
            values: values.clone(),
        })
        .unwrap();
        let decoded: Checkpoint = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            decoded
                .values
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>()
        );
        assert!(serde_json::from_str::<Checkpoint>("{\"values\":\"AQ==\"}").is_err());
    }
}
