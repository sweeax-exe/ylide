//! Fetches newer registry versions in the background (conditional GET with
//! ETag) through the network gate. Any failure leaves the current registry in place.
//!
//! The list names the runtime downloads (programs) with their checksums, so
//! the official one is signed: it is accepted only with a valid release
//! signature (`models.json.sig` next to it). A list at an address the user
//! chose is checked when it has a signature and accepted without one. When
//! the signature address answers with neither a signature nor "not found" or
//! "not allowed" (a server error, no connection), the list is not taken: it
//! may be signed.

use crate::network::NetPurpose;
use crate::settings::DEFAULT_REGISTRY_URL;
use crate::signing;
use crate::state::AppState;
use registry::store::RegistryOrigin;
use reqwest::StatusCode;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Result of a refresh, shown in the model settings.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", tag = "result")]
#[ts(export)]
pub enum RefreshOutcome {
    Updated { version: String },
    UpToDate,
    Disabled,
    Failed { message: String },
}

/// The name the release script signs the list under.
const SIGNED_NAME: &str = "models.json";

/// What the address next to the list said about its signature.
#[derive(Debug, PartialEq)]
enum Signature {
    /// A signature file, not yet checked.
    Found(String),
    /// There is none: "not found", "not allowed" (cloud storage answers a
    /// missing file that way), or a page that is not a signature (some servers
    /// answer every address with their start page).
    Missing,
    /// It could not be read (server error, no connection).
    Unreadable(String),
}

/// The signature's address: the list's path plus ".sig", with the same query,
/// so a list behind an address with a token keeps working.
fn signature_url(url: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(url).ok()?;
    parsed.set_fragment(None);
    let path = format!("{}.sig", parsed.path());
    parsed.set_path(&path);
    Some(parsed.into())
}

/// Sorts the answer of the signature address.
fn read_signature(status: StatusCode, body: Result<String, String>) -> Signature {
    if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return Signature::Missing;
    }
    if !status.is_success() {
        return Signature::Unreadable(format!("HTTP {status}"));
    }
    match body {
        Ok(text) if signing::is_signature(&text) => Signature::Found(text),
        Ok(_) => Signature::Missing,
        Err(e) => Signature::Unreadable(e),
    }
}

/// Whether a list from `url` with this signature may be used. The official
/// list must be signed; any list that comes with a signature must match it.
fn signature_ok(url: &str, body: &[u8], signature: &Signature, check: impl Fn(&[u8], &str) -> Result<(), String>) -> Result<(), String> {
    match signature {
        Signature::Found(sig) => check(body, sig),
        Signature::Missing if url == DEFAULT_REGISTRY_URL => Err("the official model list has no signature".into()),
        Signature::Missing => Ok(()),
        Signature::Unreadable(why) => Err(format!("the model list's signature could not be loaded: {why}")),
    }
}

pub async fn refresh(app: &AppHandle) -> RefreshOutcome {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if state.net.check(&settings.network, NetPurpose::Registry).is_err() {
        return RefreshOutcome::Disabled;
    }
    let url = settings.network.registry_url.trim().to_string();
    let mut request = state.net.client().get(&url);
    if let Some(etag) = state.registry_store.etag_for(&url) {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            state.net.record(NetPurpose::Registry, &url, format!("failed: {e}"));
            return RefreshOutcome::Failed { message: e.to_string() };
        }
    };
    let status = response.status();
    state.net.record(NetPurpose::Registry, &url, status.as_u16());
    if status == StatusCode::NOT_MODIFIED {
        return RefreshOutcome::UpToDate;
    }
    if !status.is_success() {
        return RefreshOutcome::Failed {
            message: format!("HTTP {status}"),
        };
    }
    let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = match response.text().await {
        Ok(b) => b,
        Err(e) => return RefreshOutcome::Failed { message: e.to_string() },
    };

    // Only a new list needs its signature; a 304 above reuses a checked one.
    let signature = match signature_url(&url) {
        None => Signature::Unreadable("the list's address is not valid".into()),
        Some(sig_url) => match state.net.client().get(&sig_url).send().await {
            Ok(r) => {
                let status = r.status();
                state.net.record(NetPurpose::Registry, &sig_url, status.as_u16());
                let text = if status.is_success() { r.text().await.map_err(|e| e.to_string()) } else { Ok(String::new()) };
                read_signature(status, text)
            }
            Err(e) => {
                state.net.record(NetPurpose::Registry, &sig_url, format!("failed: {e}"));
                Signature::Unreadable(e.to_string())
            }
        },
    };
    if let Err(message) = signature_ok(&url, body.as_bytes(), &signature, |data, sig| signing::verify(data, sig, SIGNED_NAME).map_err(|e| e.message)) {
        state.net.record(NetPurpose::Registry, &url, format!("refused: {message}"));
        return RefreshOutcome::Failed { message };
    }
    // Reaching here with a signature means it was checked.
    let signed = matches!(signature, Signature::Found(_));

    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    match state.registry_store.accept_remote(&body, etag, &url, signed, now) {
        Ok(Some(newer)) => {
            let version = newer.registry_version.clone();
            *state.registry.write().unwrap() = newer;
            *state.registry_origin.write().unwrap() = RegistryOrigin::Remote;
            let _ = app.emit("registry://updated", &version);
            RefreshOutcome::Updated { version }
        }
        Ok(None) => RefreshOutcome::UpToDate,
        Err(e) => RefreshOutcome::Failed { message: e.to_string() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::tests::{REGISTRY_FIXTURE, TEST_PUBKEY, TEST_REGISTRY_SIGNATURE, TEST_SIGNATURE};

    fn check(data: &[u8], sig: &str) -> Result<(), String> {
        signing::verify_with(data, sig, TEST_PUBKEY, SIGNED_NAME).map_err(|e| e.message)
    }

    fn found(sig: &str) -> Signature {
        Signature::Found(sig.to_string())
    }

    #[test]
    fn the_official_list_needs_a_valid_signature() {
        assert!(signature_ok(DEFAULT_REGISTRY_URL, REGISTRY_FIXTURE, &found(TEST_REGISTRY_SIGNATURE), check).is_ok());
        assert!(signature_ok(DEFAULT_REGISTRY_URL, REGISTRY_FIXTURE, &Signature::Missing, check).is_err(), "unsigned");
        assert!(signature_ok(DEFAULT_REGISTRY_URL, b"{\"registry\":\"changed\"}\n", &found(TEST_REGISTRY_SIGNATURE), check).is_err(), "changed");
        // A valid signature of another file does not count.
        assert!(signature_ok(DEFAULT_REGISTRY_URL, REGISTRY_FIXTURE, &found(TEST_SIGNATURE), check).is_err(), "other file");
    }

    /// Run by scripts/publish-registry.mjs: the list in YLIDE_RELEASE_REGISTRY
    /// must carry a signature the app accepts.
    #[test]
    #[ignore = "needs a signed list; run by scripts/publish-registry.mjs"]
    fn release_registry_is_signed_with_the_app_key() {
        let file = std::env::var("YLIDE_RELEASE_REGISTRY").expect("YLIDE_RELEASE_REGISTRY");
        let data = std::fs::read(&file).unwrap();
        let signature = std::fs::read_to_string(format!("{file}.sig")).unwrap();
        signature_ok(DEFAULT_REGISTRY_URL, &data, &found(&signature), |d, s| signing::verify(d, s, SIGNED_NAME).map_err(|e| e.message))
            .expect("the model list's signature does not match the key built into the app");
    }

    #[test]
    fn a_list_of_the_users_choice_may_be_unsigned_but_not_wrongly_signed() {
        let own = "https://example.org/models.json";
        assert!(signature_ok(own, REGISTRY_FIXTURE, &Signature::Missing, check).is_ok());
        assert!(signature_ok(own, b"{}", &found(TEST_REGISTRY_SIGNATURE), check).is_err());
    }

    #[test]
    fn a_signature_that_cannot_be_loaded_keeps_any_list_out() {
        let failed = Signature::Unreadable("HTTP 503 Service Unavailable".into());
        for url in [DEFAULT_REGISTRY_URL, "https://example.org/models.json"] {
            let err = signature_ok(url, REGISTRY_FIXTURE, &failed, check).unwrap_err();
            assert!(err.contains("503"), "{err}");
        }
    }

    #[test]
    fn tells_a_missing_signature_from_a_failed_one() {
        assert_eq!(read_signature(StatusCode::NOT_FOUND, Ok(String::new())), Signature::Missing);
        assert_eq!(read_signature(StatusCode::GONE, Ok(String::new())), Signature::Missing);
        assert_eq!(read_signature(StatusCode::OK, Ok(TEST_REGISTRY_SIGNATURE.into())), found(TEST_REGISTRY_SIGNATURE));
        // A start page served for every address is not a signature.
        assert_eq!(read_signature(StatusCode::OK, Ok("<!doctype html><title>Shop</title>".into())), Signature::Missing);
        assert!(matches!(read_signature(StatusCode::INTERNAL_SERVER_ERROR, Ok(String::new())), Signature::Unreadable(m) if m.contains("500")));
        // S3 and similar storage answer a missing file with 403.
        assert_eq!(read_signature(StatusCode::FORBIDDEN, Ok(String::new())), Signature::Missing);
        assert!(matches!(read_signature(StatusCode::BAD_GATEWAY, Ok(String::new())), Signature::Unreadable(_)));
        assert!(matches!(read_signature(StatusCode::OK, Err("connection reset".into())), Signature::Unreadable(m) if m == "connection reset"));
    }

    #[test]
    fn the_signature_sits_next_to_the_list_with_the_same_query() {
        assert_eq!(signature_url("https://ylide.app/registry/models.json").as_deref(), Some("https://ylide.app/registry/models.json.sig"));
        assert_eq!(
            signature_url("https://example.org/lists/models.json?token=a%20b&v=2#top").as_deref(),
            Some("https://example.org/lists/models.json.sig?token=a%20b&v=2")
        );
        assert_eq!(signature_url("not an address"), None);
    }
}
