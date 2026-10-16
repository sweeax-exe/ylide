//! On-disk cache of the remote registry with the bundled copy as fallback.
//!
//! The cache remembers where its list came from and whether its signature
//! was checked. A cached list counts only for the address it came from, and,
//! where a signature is required, only if it was signed: switching addresses
//! or a list cached by an older, unchecked version never outranks the
//! bundled list.

use crate::{Registry, RegistryError, bundled, is_newer, parse};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RegistryOrigin {
    /// Compiled into the app.
    Bundled,
    /// Downloaded earlier and cached.
    Cache,
    /// Just downloaded.
    Remote,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheMeta {
    etag: Option<String>,
    source_url: Option<String>,
    fetched_at_unix_ms: u64,
    /// Whether the cached list's signature was verified (absent in caches of
    /// versions before signing, which therefore count as unsigned).
    #[serde(default)]
    signed: bool,
}

/// Keeps `registry.json` + `registry.meta.json` in the app's cache directory.
pub struct RegistryStore {
    dir: PathBuf,
}

impl RegistryStore {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self { dir: cache_dir.into() }
    }

    fn data_path(&self) -> PathBuf {
        self.dir.join("registry.json")
    }

    fn meta_path(&self) -> PathBuf {
        self.dir.join("registry.meta.json")
    }

    fn meta(&self) -> Option<CacheMeta> {
        serde_json::from_str(&fs::read_to_string(self.meta_path()).ok()?).ok()
    }

    /// The newest valid registry available without network access for the
    /// list at `source_url`: the cached copy if it came from there (and was
    /// signed, when `require_signed`) and is newer, otherwise the bundled one.
    pub fn load_best_for(&self, source_url: &str, require_signed: bool) -> (Registry, RegistryOrigin) {
        self.load_best_for_any(&[source_url], require_signed)
    }

    /// Like [`Self::load_best_for`], for a list that also counts when it was
    /// cached from one of several addresses (e.g. an earlier address of the
    /// same list, until the first refresh from the new one).
    pub fn load_best_for_any(&self, source_urls: &[&str], require_signed: bool) -> (Registry, RegistryOrigin) {
        let bundled = bundled();
        let usable = self
            .meta()
            .is_some_and(|m| m.source_url.as_deref().is_some_and(|u| source_urls.contains(&u)) && (m.signed || !require_signed));
        let cached = usable.then(|| fs::read_to_string(self.data_path()).ok().and_then(|s| parse(&s).ok())).flatten();
        match cached {
            Some(cached) if is_newer(&cached.registry_version, &bundled.registry_version) => (cached, RegistryOrigin::Cache),
            _ => (bundled, RegistryOrigin::Bundled),
        }
    }

    /// ETag of the cached copy of the list at `source_url`, for conditional
    /// requests (`If-None-Match`).
    pub fn etag_for(&self, source_url: &str) -> Option<String> {
        self.meta().filter(|m| m.source_url.as_deref() == Some(source_url))?.etag
    }

    /// Validates a freshly downloaded registry from `source_url` (`signed`:
    /// its signature was verified). If it is newer than what we have for that
    /// address, it is cached and returned; an older or equal one is ignored.
    pub fn accept_remote(
        &self,
        json: &str,
        etag: Option<String>,
        source_url: &str,
        signed: bool,
        now_unix_ms: u64,
    ) -> Result<Option<Registry>, RegistryError> {
        let remote = parse(json)?;
        let (current, _) = self.load_best_for(source_url, signed);
        let previous = self.meta();
        if !is_newer(&remote.registry_version, &current.registry_version) {
            let same_source = previous.as_ref().is_some_and(|m| m.source_url.as_deref() == Some(source_url));
            if !same_source {
                // The cached list belongs to another address; it no longer counts.
                let _ = fs::remove_file(self.data_path());
            }
            // Still remember the ETag so the next request can be answered with 304.
            self.write_meta(&CacheMeta {
                etag,
                source_url: Some(source_url.to_string()),
                fetched_at_unix_ms: now_unix_ms,
                // Describes the cached data, which did not change.
                signed: same_source && previous.is_some_and(|m| m.signed),
            })?;
            return Ok(None);
        }
        fs::create_dir_all(&self.dir)?;
        write_atomic(&self.data_path(), json.as_bytes())?;
        self.write_meta(&CacheMeta {
            etag,
            source_url: Some(source_url.to_string()),
            fetched_at_unix_ms: now_unix_ms,
            signed,
        })?;
        Ok(Some(remote))
    }

    fn write_meta(&self, meta: &CacheMeta) -> Result<(), RegistryError> {
        fs::create_dir_all(&self.dir)?;
        write_atomic(&self.meta_path(), serde_json::to_string_pretty(meta)?.as_bytes())?;
        Ok(())
    }
}

/// Writes via a temporary file and rename so a crash never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("registry-store-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn bumped(version: &str) -> String {
        let mut r = bundled();
        r.registry_version = version.to_string();
        serde_json::to_string(&r).unwrap()
    }

    const OFFICIAL: &str = "https://ylide.app/registry/v2/models.json";
    const OWN: &str = "https://example.invalid/r.json";

    #[test]
    fn falls_back_to_bundled_without_cache() {
        let store = RegistryStore::new(temp_dir("empty"));
        let (r, origin) = store.load_best_for(OFFICIAL, true);
        assert_eq!(origin, RegistryOrigin::Bundled);
        assert_eq!(r, bundled());
    }

    #[test]
    fn accepts_newer_remote_and_caches_it() {
        let dir = temp_dir("newer");
        let store = RegistryStore::new(&dir);
        let accepted = store.accept_remote(&bumped("2999.1.1"), Some("\"abc\"".into()), OFFICIAL, true, 1).unwrap();
        assert!(accepted.is_some());
        let (r, origin) = store.load_best_for(OFFICIAL, true);
        assert_eq!(origin, RegistryOrigin::Cache);
        assert_eq!(r.registry_version, "2999.1.1");
        assert_eq!(store.etag_for(OFFICIAL).as_deref(), Some("\"abc\""));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ignores_older_remote_but_keeps_etag() {
        let dir = temp_dir("older");
        let store = RegistryStore::new(&dir);
        let accepted = store.accept_remote(&bumped("2000.1.1"), Some("\"old\"".into()), OWN, false, 1).unwrap();
        assert!(accepted.is_none());
        assert_eq!(store.load_best_for(OWN, false).1, RegistryOrigin::Bundled);
        assert_eq!(store.etag_for(OWN).as_deref(), Some("\"old\""));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_invalid_remote_and_keeps_previous() {
        let dir = temp_dir("invalid");
        let store = RegistryStore::new(&dir);
        assert!(store.accept_remote("{not json", None, OWN, false, 1).is_err());
        assert_eq!(store.load_best_for(OWN, false).1, RegistryOrigin::Bundled);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_cache_is_ignored() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("registry.json"), "garbage").unwrap();
        let store = RegistryStore::new(&dir);
        assert_eq!(store.load_best_for(OWN, false).1, RegistryOrigin::Bundled);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unsigned_cache_never_counts_where_a_signature_is_required() {
        // A list cached by a version before signing: no "signed" in its meta.
        let dir = temp_dir("legacy");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("registry.json"), bumped("9999.1.1")).unwrap();
        fs::write(dir.join("registry.meta.json"), format!(r#"{{"etag":null,"sourceUrl":"{OFFICIAL}","fetchedAtUnixMs":1}}"#)).unwrap();
        let store = RegistryStore::new(&dir);
        assert_eq!(store.load_best_for(OFFICIAL, true).1, RegistryOrigin::Bundled);
        // So a signed list is judged against the bundled one, not the 9999 cache.
        let accepted = store.accept_remote(&bumped("2999.1.1"), None, OFFICIAL, true, 2).unwrap();
        assert_eq!(accepted.unwrap().registry_version, "2999.1.1");
        assert_eq!(store.load_best_for(OFFICIAL, true).0.registry_version, "2999.1.1");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_earlier_address_counts_only_where_asked_for() {
        const EARLIER: &str = "https://ylide.app/registry/models.json";
        let dir = temp_dir("earlier");
        let store = RegistryStore::new(&dir);
        store.accept_remote(&bumped("2999.1.1"), None, EARLIER, true, 1).unwrap();
        assert_eq!(store.load_best_for(OFFICIAL, true).1, RegistryOrigin::Bundled);
        let (r, origin) = store.load_best_for_any(&[OFFICIAL, EARLIER], true);
        assert_eq!((r.registry_version.as_str(), origin), ("2999.1.1", RegistryOrigin::Cache));
        // The first list from the new address replaces it, judged against the bundled one.
        assert!(store.accept_remote(&bumped("2999.1.1"), None, OFFICIAL, true, 2).unwrap().is_some());
        assert_eq!(store.load_best_for(OFFICIAL, true).1, RegistryOrigin::Cache);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_list_from_another_address_does_not_count_after_switching() {
        let dir = temp_dir("switch");
        let store = RegistryStore::new(&dir);
        store.accept_remote(&bumped("9999.0.0"), Some("\"own\"".into()), OWN, false, 1).unwrap();
        assert_eq!(store.load_best_for(OWN, false).0.registry_version, "9999.0.0");
        // Back to the official address: neither the own list nor its ETag count.
        assert_eq!(store.load_best_for(OFFICIAL, true).1, RegistryOrigin::Bundled);
        assert_eq!(store.etag_for(OFFICIAL), None);
        // An official list that is not newer than the bundled one drops the own list.
        let bundled_version = bundled().registry_version;
        assert!(store.accept_remote(&bumped(&bundled_version), Some("\"o\"".into()), OFFICIAL, true, 2).unwrap().is_none());
        assert_eq!(store.load_best_for(OWN, false).1, RegistryOrigin::Bundled);
        assert_eq!(store.load_best_for(OFFICIAL, true).1, RegistryOrigin::Bundled);
        let _ = fs::remove_dir_all(dir);
    }
}
