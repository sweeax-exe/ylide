//! Memory modules (DIMMs) from the SMBIOS table, and whether they run below
//! their rated speed.
//!
//! DDR4/DDR5 kits sold as "6000 MT/s" run at the JEDEC default (DDR5: 4800)
//! until the user switches on the kit's EXPO/XMP profile in the BIOS. For
//! models whose experts sit in system RAM, generation speed follows RAM
//! bandwidth, so this is a free speed-up Ylide can point out (it never changes
//! BIOS settings itself). Firmware does not report the rated speed: it is
//! read from the part number, and the module voltage tells whether a profile
//! is already active (JEDEC DDR5 runs at 1.1 V, EXPO/XMP at 1.25-1.45 V).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One populated memory slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryModule {
    /// "DDR5", "DDR4", "LPDDR5", ... or "other".
    pub kind: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub manufacturer: String,
    pub part_number: String,
    /// Maximum speed the module reports (usually its JEDEC speed), MT/s.
    pub speed_mts: Option<u32>,
    /// Speed it runs at, MT/s.
    pub configured_mts: Option<u32>,
    /// Voltage it runs at, millivolts.
    pub configured_mv: Option<u32>,
    /// Speed the kit is sold for, read from the part number.
    pub rated_mts: Option<u32>,
}

/// RAM runs slower than the kit is rated for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RamSpeedTip {
    pub kind: String,
    pub configured_mts: u32,
    pub rated_mts: u32,
    pub part_number: String,
}

/// Memory modules of this machine; empty where the table cannot be read.
pub fn memory_modules() -> Vec<MemoryModule> {
    crate::platform::smbios_table().map(|t| parse_smbios(&t)).unwrap_or_default()
}

/// Memory devices (SMBIOS structure type 17) in a raw SMBIOS structure table.
pub fn parse_smbios(table: &[u8]) -> Vec<MemoryModule> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= table.len() {
        let kind = table[i];
        let len = table[i + 1] as usize;
        if len < 4 || i + len > table.len() {
            break;
        }
        let formatted = &table[i..i + len];
        // The string set follows the formatted area and ends with two NULs.
        let mut end = i + len;
        while end + 1 < table.len() && !(table[end] == 0 && table[end + 1] == 0) {
            end += 1;
        }
        let strings: Vec<String> = table[i + len..end.min(table.len())]
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).trim().to_string())
            .collect();
        if kind == 17
            && let Some(m) = memory_device(formatted, &strings)
        {
            out.push(m);
        }
        if kind == 127 {
            break;
        }
        i = end + 2;
    }
    out
}

fn memory_device(f: &[u8], strings: &[String]) -> Option<MemoryModule> {
    let byte = |o: usize| f.get(o).copied();
    let word = |o: usize| f.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let dword = |o: usize| f.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let string = |o: usize| byte(o).filter(|n| *n > 0).and_then(|n| strings.get(n as usize - 1)).cloned().unwrap_or_default();
    // A speed of 0 is unknown; 0xFFFF points to the 32-bit field (SMBIOS 3.3).
    let speed = |o: usize, extended: usize| match word(o) {
        Some(0) | None => None,
        Some(0xFFFF) => dword(extended).map(|s| s & 0x7FFF_FFFF).filter(|s| *s > 0),
        Some(s) => Some(s as u32),
    };

    let size_bytes = match word(0x0C)? {
        0 | 0xFFFF => return None, // empty slot / unknown
        0x7FFF => dword(0x1C)? as u64 * (1 << 20),
        s if s & 0x8000 != 0 => (s & 0x7FFF) as u64 * 1024,
        s => s as u64 * (1 << 20),
    };
    let kind = match byte(0x12) {
        Some(0x18) => "DDR3",
        Some(0x1A) => "DDR4",
        Some(0x1B) => "LPDDR",
        Some(0x1E) => "LPDDR4",
        Some(0x22) => "DDR5",
        Some(0x23) => "LPDDR5",
        _ => "other",
    }
    .to_string();
    let part_number = string(0x1A);
    Some(MemoryModule {
        kind,
        size_bytes,
        manufacturer: string(0x17),
        rated_mts: rated_mts_from_part(&part_number),
        part_number,
        speed_mts: speed(0x15, 0x54),
        configured_mts: speed(0x20, 0x58),
        configured_mv: word(0x26).filter(|v| *v > 0).map(u32::from),
    })
}

/// Transfer rates kits are sold at (MT/s).
const KNOWN_SPEEDS: [u32; 30] = [
    2133, 2400, 2666, 2667, 2800, 2933, 3000, 3200, 3333, 3466, 3600, 3733, 3800, 4000, 4133, 4266, 4400, 4600, 4800, 5200, 5600, 6000, 6200,
    6400, 6600, 6800, 7200, 7600, 8000, 8400,
];

/// The speed a kit is sold for, from its part number: a plain speed
/// ("6000 Series", Corsair "CMK32GX5M2B6000C30", G.Skill "F5-6000J3038F16G")
/// or a two-digit code (Kingston "KF560C30-16", Crucial "CP16G60C36U5B").
pub fn rated_mts_from_part(part: &str) -> Option<u32> {
    let p = part.trim().to_uppercase();
    let bytes = p.as_bytes();
    let digits_at = |start: usize, n: usize| -> Option<u32> {
        let s = p.get(start..start + n)?;
        let boundary = |i: Option<&u8>| i.is_none_or(|c| !c.is_ascii_digit());
        (s.bytes().all(|c| c.is_ascii_digit()) && boundary(start.checked_sub(1).and_then(|i| bytes.get(i))) && boundary(bytes.get(start + n)))
            .then(|| s.parse().ok())
            .flatten()
    };
    // A four-digit speed standing alone.
    for i in 0..bytes.len() {
        if let Some(v) = digits_at(i, 4)
            && KNOWN_SPEEDS.contains(&v)
        {
            return Some(v);
        }
    }
    // Two-digit codes in hundreds: Kingston KF5/KF4 + speed + C, KVR + speed;
    // Crucial <size>G + speed + C + latency.
    let code = |v: u32| (KNOWN_SPEEDS.contains(&(v * 100))).then_some(v * 100);
    if let Some(rest) = p.strip_prefix("KF5").or_else(|| p.strip_prefix("KF4"))
        && rest.as_bytes().get(2) == Some(&b'C')
    {
        return rest.get(..2).and_then(|d| d.parse().ok()).and_then(code);
    }
    if let Some(rest) = p.strip_prefix("KVR") {
        return rest.get(..2).and_then(|d| d.parse().ok()).and_then(code);
    }
    if p.starts_with("CP") || p.starts_with("CT") {
        let g = p.find('G')?;
        if p.as_bytes().get(g + 3) == Some(&b'C') {
            return digits_at(g + 1, 2).and_then(code);
        }
    }
    None
}

/// JEDEC voltage of the module type (mV); a profile (EXPO/XMP) raises it.
fn jedec_mv(kind: &str) -> Option<u32> {
    match kind {
        "DDR5" => Some(1100),
        "DDR4" => Some(1200),
        _ => None,
    }
}

/// The tip when every module is a DDR4/DDR5 kit with a known rated speed,
/// they run slower than that, and at JEDEC voltage (no profile active).
pub fn ram_speed_tip(modules: &[MemoryModule]) -> Option<RamSpeedTip> {
    let first = modules.first()?;
    let mut configured = u32::MAX;
    let mut rated = u32::MAX;
    for m in modules {
        let jedec = jedec_mv(&m.kind)?;
        if m.kind != first.kind || m.configured_mv.is_some_and(|mv| mv > jedec + 20) {
            return None;
        }
        configured = configured.min(m.configured_mts?);
        rated = rated.min(m.rated_mts?);
    }
    // Below 4 % is board rounding (e.g. 5986 for 6000), not a missing profile.
    (rated as f64 > configured as f64 * 1.04).then(|| RamSpeedTip {
        kind: first.kind.clone(),
        configured_mts: configured,
        rated_mts: rated,
        part_number: first.part_number.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rated_speed_from_part_numbers() {
        for (part, rated) in [
            ("6000 Series", Some(6000)),
            ("CMK32GX5M2B6000C30", Some(6000)),
            ("F5-6000J3038F16G", Some(6000)),
            ("F4-3600C16-16GTZNC", Some(3600)),
            ("KF560C30-16", Some(6000)),
            ("KF432C16BB/16", Some(3200)),
            ("KVR48U40BS8-16", Some(4800)),
            ("CP16G60C36U5B.M8D1", Some(6000)),
            ("CT16G48C40U5.M8A1", Some(4800)),
            ("M323R2GA3BB0-CQKOL", None),
            ("Unknown", None),
            ("", None),
        ] {
            assert_eq!(rated_mts_from_part(part), rated, "{part}");
        }
    }

    /// One type-17 structure: SMBIOS 3.3 layout (0x5C bytes) with strings.
    pub(crate) fn dimm(kind: u8, size_mb: u32, speed: u16, configured: u16, mv: u16, part: &str) -> Vec<u8> {
        let mut f = vec![0u8; 0x5C];
        f[0] = 17;
        f[1] = 0x5C;
        // From 32 GiB on, the size moves to the 32-bit Extended Size field.
        let size = if size_mb >= 0x7FFF { 0x7FFF } else { size_mb as u16 };
        f[0x0C..0x0E].copy_from_slice(&size.to_le_bytes());
        f[0x1C..0x20].copy_from_slice(&size_mb.to_le_bytes());
        f[0x10] = 1; // device locator
        f[0x12] = kind;
        f[0x15..0x17].copy_from_slice(&speed.to_le_bytes());
        f[0x17] = 2; // manufacturer
        f[0x20..0x22].copy_from_slice(&configured.to_le_bytes());
        f[0x26..0x28].copy_from_slice(&mv.to_le_bytes());
        let mut strings = vec!["DIMM 1", "Unknown"];
        // Empty strings are not stored: their index is 0.
        if !part.is_empty() {
            strings.push(part);
            f[0x1A] = 3;
        }
        for s in strings {
            f.extend_from_slice(s.as_bytes());
            f.push(0);
        }
        f.push(0);
        f
    }

    fn table(parts: &[Vec<u8>]) -> Vec<u8> {
        let mut t = vec![0u8, 4, 0, 0, 0, 0]; // a type-0 stub without strings
        for p in parts {
            t.extend_from_slice(p);
        }
        t.extend_from_slice(&[127, 4, 0, 0, 0, 0]);
        t
    }

    #[test]
    fn reads_memory_devices_from_the_smbios_table() {
        // This PC: two 32 GB DDR5 "6000 Series" modules at 4800 MT/s and 1.1 V.
        let ddr5 = dimm(0x22, 32768, 4800, 4800, 1100, "6000 Series");
        let empty = dimm(0x22, 0, 0, 0, 0, "");
        let modules = parse_smbios(&table(&[ddr5.clone(), empty, ddr5]));
        assert_eq!(modules.len(), 2, "the empty slot is skipped");
        let m = &modules[0];
        assert_eq!((m.kind.as_str(), m.size_bytes), ("DDR5", 32 << 30));
        assert_eq!((m.speed_mts, m.configured_mts, m.configured_mv, m.rated_mts), (Some(4800), Some(4800), Some(1100), Some(6000)));
        assert_eq!((m.manufacturer.as_str(), m.part_number.as_str()), ("Unknown", "6000 Series"));
        let tip = ram_speed_tip(&modules).expect("EXPO is off");
        assert_eq!((tip.configured_mts, tip.rated_mts), (4800, 6000));
    }

    #[test]
    fn extended_speed_and_size_fields() {
        let mut d = dimm(0x22, 65536, 0xFFFF, 0xFFFF, 1350, "X");
        d[0x54..0x58].copy_from_slice(&8800u32.to_le_bytes());
        d[0x58..0x5C].copy_from_slice(&8000u32.to_le_bytes());
        let m = &parse_smbios(&table(&[d]))[0];
        assert_eq!((m.size_bytes, m.speed_mts, m.configured_mts), (64 << 30, Some(8800), Some(8000)));
        // An old 2.x table ends before the speed fields.
        let mut short = dimm(0x1A, 8192, 2400, 2400, 0, "Y");
        short.drain(0x15..0x5C);
        short[1] = 0x15;
        let m = &parse_smbios(&table(&[short]))[0];
        assert_eq!((m.kind.as_str(), m.speed_mts, m.configured_mts), ("DDR4", None, None));
        assert!(parse_smbios(&[1, 2]).is_empty(), "truncated input");
    }

    #[test]
    fn no_tip_when_a_profile_runs_or_nothing_is_known() {
        let module = |kind: &str, configured, mv, rated| MemoryModule {
            kind: kind.into(),
            size_bytes: 16 << 30,
            manufacturer: String::new(),
            part_number: "P".into(),
            speed_mts: Some(4800),
            configured_mts: Some(configured),
            configured_mv: mv,
            rated_mts: rated,
        };
        assert!(ram_speed_tip(&[module("DDR5", 4800, Some(1100), Some(6000))]).is_some());
        assert!(ram_speed_tip(&[module("DDR5", 4800, None, Some(6000))]).is_some(), "voltage not reported");
        assert!(ram_speed_tip(&[module("DDR5", 6000, Some(1350), Some(6000))]).is_none(), "EXPO on");
        assert!(ram_speed_tip(&[module("DDR5", 5600, Some(1250), Some(6000))]).is_none(), "a profile at a lower speed is the user's choice");
        assert!(ram_speed_tip(&[module("DDR5", 4800, Some(1100), Some(4800))]).is_none(), "a JEDEC kit");
        assert!(ram_speed_tip(&[module("DDR5", 5986, Some(1100), Some(6000))]).is_none(), "rounding");
        assert!(ram_speed_tip(&[module("DDR5", 4800, Some(1100), None)]).is_none(), "unknown part number");
        assert!(ram_speed_tip(&[module("DDR5", 4800, Some(1100), Some(6000)), module("DDR5", 4800, Some(1100), None)]).is_none());
        assert!(ram_speed_tip(&[module("LPDDR5", 4800, Some(1100), Some(6400))]).is_none(), "soldered memory has no profile");
        assert!(ram_speed_tip(&[module("DDR4", 2133, Some(1200), Some(3200))]).is_some());
        assert!(ram_speed_tip(&[]).is_none());
    }

    /// Prints this machine's modules: `cargo test -p hardware this_machine -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn this_machine() {
        let modules = memory_modules();
        println!("{modules:#?}
tip: {:?}", ram_speed_tip(&modules));
    }
}
