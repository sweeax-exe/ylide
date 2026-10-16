//! Signatures of what ylide.app publishes: update installers and the model
//! list. Both are signed with the release key (`tauri signer`); the app holds
//! its public half and checks the signature and the signed file name.

use crate::error::{AppError, AppResult};
use base64::Engine;

/// Public half of the release signing key (`tauri signer generate`). The
/// private half never enters the repository; see docs/releasing.md.
pub const RELEASE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEMxOTlCMjZCMUNGNDg1NTMKUldSVGhmUWNhN0tad1JoU2ZQSmNoNW04T1NHQUdsK1ZGRjNVOGdlOUhUVjBNd2ZwWTNtMXBnZ3YK";

/// Checks `data` against a release signature made for the file `file_name`.
pub fn verify(data: &[u8], signature: &str, file_name: &str) -> AppResult<()> {
    verify_with(data, signature, RELEASE_PUBKEY, file_name)
}

/// Whether `text` has the form of a `tauri signer` signature, whoever made it
/// and for whatever file; an error page a server sends instead does not.
pub fn is_signature(text: &str) -> bool {
    decode(text).is_some_and(|t| minisign_verify::Signature::decode(&t).is_ok())
}

/// The text inside a base64 key or signature file.
fn decode(s: &str) -> Option<String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

/// Checks `data` against a `tauri signer` signature (base64 of the minisign
/// signature file) and public key (base64 of the minisign key file), and that
/// the signed file name is `file_name`.
pub fn verify_with(data: &[u8], signature: &str, pubkey: &str, file_name: &str) -> AppResult<()> {
    let refuse = |why: String| AppError::new("update_signature", why);
    let key_text = decode(pubkey).ok_or_else(|| refuse("the built-in release key cannot be read".into()))?;
    let key = minisign_verify::PublicKey::decode(&key_text).map_err(|e| refuse(format!("the built-in release key is invalid: {e}")))?;
    let sig_text = decode(signature).ok_or_else(|| refuse("the signature is not valid".into()))?;
    let sig = minisign_verify::Signature::decode(&sig_text).map_err(|e| refuse(format!("the signature is not valid: {e}")))?;
    // Only prehashed signatures, which is what `tauri signer` writes.
    key.verify(data, &sig, false)
        .map_err(|e| refuse(format!("{file_name} does not match its signature ({e})")))?;
    // The trusted comment is covered by the signature: "timestamp:<t>\tfile:<name>".
    let expected = format!("file:{file_name}");
    if !sig.trusted_comment().split('\t').any(|field| field == expected) {
        return Err(refuse(format!("the signature is not for {file_name}")));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Throwaway key pair, and signatures made with `tauri signer sign`.
    pub const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc1RjQyODVDRDlCOUYyM0QKUldROThyblpYQ2owZFY3UHJKR3QwRzN3QWlvZjN6a0lQNytnYWF6UFpGK2I5ZzFuUWt3UDA5ek0K";
    /// Signature of FIXTURE as "fixture.bin".
    pub const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVROThyblpYQ2owZFUwWmlxemhUTmMvbllrZ3VnTHdpbXdOUWRidVJ1TnRhT0lxRUUxUkpoaDdsZ1YwNG4ybU5tdWxzYm1sWTJhQVpMK055QjhkLy9lRHNNUlhiRWQ3YUFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMTY3NzQzCWZpbGU6Zml4dHVyZS5iaW4KMk15eDZ6K1RiVVg0T09nMVpvKzQ1TmI1ak12MWhOQWdmcTE4NUQwbHhicXZOQkx6dng5NVk3R05CYVRqeXRIMGhTeTVFenRxMnpndDA5WWVrQnRqREE9PQo=";
    pub const FIXTURE: &[u8] = b"ylide update test\n";
    /// Signature of REGISTRY_FIXTURE as "models.json".
    pub const TEST_REGISTRY_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVROThyblpYQ2owZGJmT2M0V1hIV0VpNnUzUWNHaTRpeWxXL2gyNXh6eFJ2dnRDcFdBQUxoQkVFdlVOMUJST1A1c0NGd0k5dWxuWDJzN0VIWGtza2h1eGtvK3ZBODE5bkF3PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMTc0MTYxCWZpbGU6bW9kZWxzLmpzb24Kd3RwUGZQZTljQ3VSQVg2bFA1QnhnQnpDSE9DQkZuMi9zSjQ4NlVpUWNua2k3cVN2ek5EMVZtZ2FsaWFLRFVNb1hWRkpUdWFxdDY1bEpZT3FuUk9rQUE9PQo=";
    pub const REGISTRY_FIXTURE: &[u8] = b"{\"registry\":\"test\"}\n";

    #[test]
    fn accepts_a_real_tauri_signature() {
        verify_with(FIXTURE, TEST_SIGNATURE, TEST_PUBKEY, "fixture.bin").unwrap();
        verify_with(REGISTRY_FIXTURE, TEST_REGISTRY_SIGNATURE, TEST_PUBKEY, "models.json").unwrap();
    }

    #[test]
    fn refuses_changed_data_foreign_keys_and_other_names() {
        assert_eq!(verify_with(b"ylide update test!\n", TEST_SIGNATURE, TEST_PUBKEY, "fixture.bin").unwrap_err().code, "update_signature");
        // The real release key did not sign the fixtures.
        assert_eq!(verify(FIXTURE, TEST_SIGNATURE, "fixture.bin").unwrap_err().code, "update_signature");
        assert_eq!(verify_with(FIXTURE, "not base64 !", TEST_PUBKEY, "fixture.bin").unwrap_err().code, "update_signature");
        // A valid signature of another file cannot be reused under a new name.
        let err = verify_with(FIXTURE, TEST_SIGNATURE, TEST_PUBKEY, "Ylide_9.9.9_x64-setup.exe").unwrap_err();
        assert!(err.message.contains("Ylide_9.9.9_x64-setup.exe"), "{}", err.message);
    }

    #[test]
    fn tells_signatures_from_other_text() {
        assert!(is_signature(TEST_SIGNATURE));
        assert!(is_signature(&format!("{TEST_REGISTRY_SIGNATURE}\n")));
        assert!(!is_signature("<!doctype html><title>Not found</title>"));
        assert!(!is_signature(""));
        // Base64, but of something else (here: the public key).
        assert!(!is_signature(TEST_PUBKEY));
    }

    #[test]
    fn built_in_key_is_a_minisign_public_key() {
        let text = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(RELEASE_PUBKEY).unwrap()).unwrap();
        minisign_verify::PublicKey::decode(&text).unwrap();
    }
}
