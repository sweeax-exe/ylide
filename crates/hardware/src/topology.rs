//! CPU layout for pinning llama.cpp's threads: the physical cores, and which
//! of them share an L3 cache (a CCD on Ryzen; on the 9950X3D the first CCD
//! has the 96 MB V-Cache). Only processor group 0 (the first 64 logical CPUs)
//! is described, which is what a single affinity mask can address.

/// Logical CPUs, grouped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CpuTopology {
    /// The logical CPUs of each physical core (SMT siblings together).
    pub cores: Vec<Vec<u32>>,
    /// L3 caches with the logical CPUs that share each one.
    pub l3: Vec<CacheGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheGroup {
    pub size_bytes: u64,
    pub cpus: Vec<u32>,
}

impl CpuTopology {
    /// The first logical CPU of every physical core, limited to `within`.
    pub fn physical_cpus(&self, within: Option<&[u32]>) -> Vec<u32> {
        self.cores
            .iter()
            .filter_map(|core| core.iter().copied().min())
            .filter(|cpu| within.is_none_or(|w| w.contains(cpu)))
            .collect()
    }

    /// The L3 group with the largest cache, when there are several of
    /// different or equal size (two CCDs); `None` on single-L3 CPUs.
    pub fn largest_l3(&self) -> Option<&CacheGroup> {
        if self.l3.len() < 2 {
            return None;
        }
        self.l3.iter().max_by(|a, b| a.size_bytes.cmp(&b.size_bytes).then(b.cpus.first().cmp(&a.cpus.first())))
    }
}

/// llama.cpp's affinity mask format (`-C`): hex with a `0x` prefix.
pub fn cpu_mask(cpus: &[u32]) -> Option<String> {
    let mask = cpus.iter().filter(|c| **c < 64).fold(0u64, |m, c| m | (1 << c));
    (mask != 0).then(|| format!("0x{mask:X}"))
}

/// This machine's layout, where the OS describes it.
pub fn cpu_topology() -> Option<CpuTopology> {
    crate::platform::processor_information().map(|buf| parse_processor_information(&buf)).filter(|t| !t.cores.is_empty())
}

/// Parses the buffer of Windows' `GetLogicalProcessorInformationEx(RelationAll)`:
/// variable-size records of `Relationship` (u32) and `Size` (u32), then
/// `PROCESSOR_RELATIONSHIP` (core: group mask at offset 32) or
/// `CACHE_RELATIONSHIP` (level at 8, size at 12, group mask at 40).
pub fn parse_processor_information(buf: &[u8]) -> CpuTopology {
    const CORE: u32 = 0;
    const CACHE: u32 = 2;
    let u16_at = |b: &[u8], o: usize| b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]]));
    let u32_at = |b: &[u8], o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]));
    let u64_at = |b: &[u8], o: usize| b.get(o..o + 8).map(|x| u64::from_le_bytes(x.try_into().unwrap()));
    // Logical CPUs of group 0 in a GROUP_AFFINITY at `o` (mask u64, group u16).
    let cpus_at = |b: &[u8], o: usize| -> Vec<u32> {
        match (u64_at(b, o), u16_at(b, o + 8)) {
            (Some(mask), Some(0)) => (0..64).filter(|i| mask & (1 << i) != 0).collect(),
            _ => vec![],
        }
    };
    let mut topo = CpuTopology::default();
    let mut i = 0;
    while let (Some(kind), Some(size)) = (u32_at(buf, i), u32_at(buf, i + 4)) {
        let size = size as usize;
        if size < 8 || i + size > buf.len() {
            break;
        }
        let rec = &buf[i..i + size];
        match kind {
            CORE => {
                let cpus = cpus_at(rec, 32);
                if !cpus.is_empty() {
                    topo.cores.push(cpus);
                }
            }
            CACHE if rec.get(8) == Some(&3) => {
                let cpus = cpus_at(rec, 40);
                if let Some(size) = u32_at(rec, 12)
                    && !cpus.is_empty()
                {
                    topo.l3.push(CacheGroup { size_bytes: size as u64, cpus });
                }
            }
            _ => {}
        }
        i += size;
    }
    topo
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core(mask: u64) -> Vec<u8> {
        let mut r = vec![0u8; 48];
        r[4..8].copy_from_slice(&48u32.to_le_bytes());
        r[30..32].copy_from_slice(&1u16.to_le_bytes());
        r[32..40].copy_from_slice(&mask.to_le_bytes());
        r
    }

    fn cache(level: u8, size: u32, mask: u64) -> Vec<u8> {
        let mut r = vec![0u8; 56];
        r[0..4].copy_from_slice(&2u32.to_le_bytes());
        r[4..8].copy_from_slice(&56u32.to_le_bytes());
        r[8] = level;
        r[12..16].copy_from_slice(&size.to_le_bytes());
        r[38..40].copy_from_slice(&1u16.to_le_bytes());
        r[40..48].copy_from_slice(&mask.to_le_bytes());
        r
    }

    /// The 9950X3D as Windows describes it: 16 cores with two threads each,
    /// SMT siblings numbered next to each other; 96 MB L3 on CPUs 0-15 and
    /// 32 MB on 16-31.
    pub(crate) fn ryzen_9950x3d() -> Vec<u8> {
        let mut buf = Vec::new();
        for c in 0..16u64 {
            buf.extend(core(0b11 << (2 * c)));
            if c % 8 == 0 {
                buf.extend(cache(2, 1 << 20, 0b11 << (2 * c)));
            }
        }
        buf.extend(cache(3, 96 << 20, 0xFFFF));
        buf.extend(cache(3, 32 << 20, 0xFFFF_0000));
        buf
    }

    #[test]
    fn finds_cores_and_ccds() {
        let t = parse_processor_information(&ryzen_9950x3d());
        assert_eq!(t.cores.len(), 16);
        assert_eq!(t.cores[1], vec![2, 3]);
        assert_eq!(t.l3.len(), 2, "L2 caches are ignored");
        let all = t.physical_cpus(None);
        assert_eq!(cpu_mask(&all).as_deref(), Some("0x55555555"));
        let vcache = t.largest_l3().unwrap();
        assert_eq!(vcache.size_bytes, 96 << 20);
        let ccd0 = t.physical_cpus(Some(&vcache.cpus));
        assert_eq!((ccd0.len(), cpu_mask(&ccd0).as_deref()), (8, Some("0x5555")));
    }

    #[test]
    fn single_ccd_and_broken_input() {
        let mut buf = Vec::new();
        for c in 0..8u64 {
            buf.extend(core(0b11 << (2 * c)));
        }
        buf.extend(cache(3, 32 << 20, 0xFFFF));
        let t = parse_processor_information(&buf);
        assert_eq!(t.physical_cpus(None).len(), 8);
        assert!(t.largest_l3().is_none(), "nothing to choose between");
        assert_eq!(parse_processor_information(&[1, 2, 3]), CpuTopology::default());
        assert_eq!(cpu_mask(&[]), None);
    }

    /// Prints this machine's layout: `cargo test -p hardware this_cpu -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn this_cpu() {
        let t = cpu_topology();
        println!("{t:#?}");
        if let Some(t) = t {
            println!("all physical: {:?}", cpu_mask(&t.physical_cpus(None)));
            if let Some(g) = t.largest_l3() {
                println!("largest L3 ({} MB): {:?}", g.size_bytes >> 20, cpu_mask(&t.physical_cpus(Some(&g.cpus))));
            }
        }
    }
}
