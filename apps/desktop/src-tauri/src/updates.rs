//! Updates: Ylide asks one fixed address whether a newer version exists. Only
//! when the user says so does it download the installer and check its
//! signature against the key built into the app; and only after the user
//! confirms once more does it stop the model and hand over to the installer.
//!
//! The version offered in `latest.json` is not signed itself, so the signed
//! file name in the signature's trusted comment must name that version: a
//! changed `latest.json` cannot pass an older signed installer off as new.
//!
//! The update file has the format of Tauri's updater (`latest.json` with
//! minisign signatures made by `tauri signer`), so the usual Tauri release
//! tooling produces it. Both requests go through the network gate and can be
//! switched off in the settings.

use crate::error::{AppError, AppResult};
use crate::network::NetPurpose;
use crate::signing;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use ts_rs::TS;

/// Where Ylide looks for updates. It is on the project's own domain, so the
/// hosting behind it can change without cutting off older versions.
pub const UPDATE_URL: &str = "https://ylide.app/updates/latest.json";


/// `latest.json` is a few hundred bytes; anything this large is not one.
const MAX_MANIFEST_BYTES: u64 = 1 << 20;
/// The installer is well below 200 MB; this only stops a runaway download.
const MAX_INSTALLER_BYTES: u64 = 1 << 30;
/// Progress is reported in steps of this size.
const PROGRESS_STEP: u64 = 512 * 1024;
/// Longest wait for the next piece of a download before giving up.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Result of an update check, shown in the settings and as a notice.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "result")]
#[ts(export)]
pub enum UpdateOutcome {
    Available {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    UpToDate,
    Disabled,
    Failed {
        message: String,
    },
}

/// Download progress of the installer.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateProgress {
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
}

/// The newer version found by the last check, ready to install.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingUpdate {
    pub version: String,
    pub url: String,
    pub signature: String,
}

/// A downloaded and verified installer, waiting for the user's go.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadyUpdate {
    pub version: String,
    pub path: PathBuf,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    #[serde(default)]
    platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

#[derive(Debug, PartialEq)]
struct Found {
    pending: PendingUpdate,
    notes: Option<String>,
    date: Option<String>,
}

/// Platform key as Tauri writes it into `latest.json`, e.g. `windows-x86_64`.
fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// The installer file name the release script signs, e.g. `Ylide_0.2.0_x64-setup.exe`.
fn installer_name(product: &str, version: &str) -> String {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{product}_{version}_{arch}-setup.exe")
}

/// Reads `latest.json`; returns the update for `platform` if its version is
/// newer than `current`.
fn evaluate(body: &str, current: &str, platform: &str) -> Result<Option<Found>, String> {
    let manifest: Manifest = serde_json::from_str(body).map_err(|e| format!("the update file is not valid: {e}"))?;
    let version = manifest.version.trim().trim_start_matches('v');
    let offered = semver::Version::parse(version).map_err(|e| format!("the update file has an invalid version {version:?}: {e}"))?;
    let current = semver::Version::parse(current).map_err(|e| format!("invalid app version {current:?}: {e}"))?;
    // Build metadata does not take part in a release's identity; "0.2.0+1"
    // must not count as newer than 0.2.0.
    if !offered.build.is_empty() {
        return Err(format!("the update file has build metadata in its version {offered}"));
    }
    if offered <= current {
        return Ok(None);
    }
    // Tauri's tooling writes "<platform>-nsis" for the NSIS installer and
    // may write the plain key as well.
    let entry = manifest
        .platforms
        .get(&format!("{platform}-nsis"))
        .or_else(|| manifest.platforms.get(platform))
        .ok_or_else(|| format!("version {offered} has no build for {platform}"))?;
    Ok(Some(Found {
        pending: PendingUpdate {
            version: offered.to_string(),
            url: entry.url.trim().to_string(),
            signature: entry.signature.trim().to_string(),
        },
        notes: manifest.notes.filter(|n| !n.trim().is_empty()),
        date: manifest.pub_date,
    }))
}

/// The installer must be an HTTPS link to an `.exe` (the NSIS installer).
fn check_installer_url(url: &str) -> AppResult<()> {
    let parsed = reqwest::Url::parse(url).map_err(|e| AppError::new("update_format", format!("invalid installer address: {e}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::new("update_format", "the installer address must use HTTPS"));
    }
    if !parsed.path().to_ascii_lowercase().ends_with(".exe") {
        return Err(AppError::new("update_format", "the update is not a Windows installer (.exe)"));
    }
    Ok(())
}

/// Reads a response body, refusing more than `cap` bytes.
async fn read_capped(mut response: reqwest::Response, cap: u64, mut progress: impl FnMut(u64, Option<u64>)) -> AppResult<Vec<u8>> {
    let total = response.content_length();
    let too_large = || AppError::new("update_too_large", format!("the download is larger than {} MB", cap >> 20));
    if total.is_some_and(|t| t > cap) {
        return Err(too_large());
    }
    let mut data = Vec::with_capacity(total.unwrap_or(0).min(cap) as usize);
    let mut reported = 0;
    loop {
        let next = tokio::time::timeout(STALL_TIMEOUT, response.chunk())
            .await
            .map_err(|_| AppError::new("network", format!("the download stalled: no data for {} seconds", STALL_TIMEOUT.as_secs())))??;
        let Some(chunk) = next else { break };
        if (data.len() + chunk.len()) as u64 > cap {
            return Err(too_large());
        }
        data.extend_from_slice(&chunk);
        let len = data.len() as u64;
        if len - reported >= PROGRESS_STEP {
            reported = len;
            progress(len, total);
        }
    }
    progress(data.len() as u64, total);
    Ok(data)
}

/// Asks the update address whether a newer version exists.
pub async fn check(app: &AppHandle) -> UpdateOutcome {
    let state = app.state::<AppState>();
    if state.net.check(&state.settings().network, NetPurpose::UpdateCheck).is_err() {
        return UpdateOutcome::Disabled;
    }
    let response = match state.net.client().get(UPDATE_URL).timeout(Duration::from_secs(30)).send().await {
        Ok(r) => r,
        Err(e) => {
            state.net.record(NetPurpose::UpdateCheck, UPDATE_URL, format!("failed: {e}"));
            return UpdateOutcome::Failed { message: e.to_string() };
        }
    };
    let status = response.status();
    state.net.record(NetPurpose::UpdateCheck, UPDATE_URL, status.as_u16());
    // 204 is the Tauri convention for "nothing newer".
    if status == reqwest::StatusCode::NO_CONTENT {
        return UpdateOutcome::UpToDate;
    }
    if !status.is_success() {
        return UpdateOutcome::Failed {
            message: format!("HTTP {status}"),
        };
    }
    let body = match read_capped(response, MAX_MANIFEST_BYTES, |_, _| {}).await {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) => return UpdateOutcome::Failed { message: e.message },
    };
    let current = app.package_info().version.to_string();
    match evaluate(&body, &current, &platform_key()) {
        Ok(Some(found)) => {
            let outcome = UpdateOutcome::Available {
                version: found.pending.version.clone(),
                notes: found.notes,
                date: found.date,
            };
            let mut ready = state.ready_update.lock().unwrap();
            if ready.as_ref().is_some_and(|r| r.version != found.pending.version) {
                *ready = None;
            }
            *state.pending_update.lock().unwrap() = Some(found.pending);
            outcome
        }
        Ok(None) => {
            *state.pending_update.lock().unwrap() = None;
            UpdateOutcome::UpToDate
        }
        Err(message) => UpdateOutcome::Failed { message },
    }
}

/// The startup check runs once per start of Ylide: a reload of the window gets
/// the same answer instead of asking ylide.app again.
pub async fn check_at_startup(app: &AppHandle) -> UpdateOutcome {
    let state = app.state::<AppState>();
    let mut cached = state.startup_update.lock().await;
    if let Some(outcome) = cached.as_ref() {
        return outcome.clone();
    }
    let outcome = check(app).await;
    if !matches!(outcome, UpdateOutcome::Failed { .. }) {
        *cached = Some(outcome.clone());
    }
    outcome
}

/// Downloads the update found by the last check and verifies it. Nothing is
/// stopped or closed yet; `launch` does that after the user's go.
pub async fn download(app: &AppHandle, on_progress: Channel<UpdateProgress>) -> AppResult<()> {
    let state = app.state::<AppState>();
    let pending = state
        .pending_update
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::new("update_none", "no update to install; check for updates first"))?;
    if state.ready_update.lock().unwrap().as_ref().is_some_and(|r| r.version == pending.version) {
        return Ok(());
    }
    state.net.check(&state.settings().network, NetPurpose::UpdateDownload)?;
    check_installer_url(&pending.url)?;
    if state.update_installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("update_busy", "the update is already being downloaded"));
    }
    let result = fetch_and_store(app, &state, &pending, &on_progress).await;
    state.update_installing.store(false, Ordering::SeqCst);
    let ready = result?;
    *state.ready_update.lock().unwrap() = Some(ready);
    Ok(())
}

async fn fetch_and_store(app: &AppHandle, state: &AppState, pending: &PendingUpdate, on_progress: &Channel<UpdateProgress>) -> AppResult<ReadyUpdate> {
    state.net.record(NetPurpose::UpdateDownload, &pending.url, "requested");
    let bytes = match fetch_installer(state, &pending.url, on_progress).await {
        Ok(b) => b,
        Err(e) => {
            state.net.record(NetPurpose::UpdateDownload, &pending.url, format!("failed: {}", e.message));
            return Err(e);
        }
    };
    let name = installer_name(&app.package_info().name, &pending.version);
    if let Err(e) = signing::verify(&bytes, &pending.signature, &name) {
        state.net.record(NetPurpose::UpdateDownload, &pending.url, format!("refused: {}", e.message));
        return Err(e);
    }
    state.net.record(NetPurpose::UpdateDownload, &pending.url, "completed, signature verified");
    let dir = state.paths.cache.join("updates");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&name);
    std::fs::write(&path, &bytes)?;
    Ok(ReadyUpdate {
        version: pending.version.clone(),
        path,
        signature: pending.signature.clone(),
    })
}

/// Checks the downloaded installer once more, stops the model and starts the
/// installer, which closes Ylide and starts it again. If the installer cannot
/// be started, the model is started again.
pub async fn launch(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let ready = state
        .ready_update
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::new("update_none", "no downloaded update; download it first"))?;
    // The file waited on disk; verify what is actually started.
    let bytes = std::fs::read(&ready.path)?;
    let name = installer_name(&app.package_info().name, &ready.version);
    signing::verify(&bytes, &ready.signature, &name)?;
    drop(bytes);

    // Free the GPU and release the bundled runtime files the installer replaces.
    let was_running = state.runtime.info();
    state.runtime.stop(app).await;
    if let Err(e) = launch_installer(&ready.path) {
        if let Some(info) = was_running {
            let restarted = if info.runtime == "external" {
                state.runtime.use_external(app, &state.settings()).await.map(|_| ())
            } else {
                crate::commands::server_start(app.clone(), app.state::<AppState>(), None).await.map(|_| ())
            };
            if let Err(again) = restarted {
                tracing::warn!("model not restarted after a failed update: {again}");
            }
        }
        return Err(e);
    }
    // The installer closes a running Ylide itself; leaving now saves it the wait.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        app.exit(0);
    });
    Ok(())
}

async fn fetch_installer(state: &AppState, url: &str, on_progress: &Channel<UpdateProgress>) -> AppResult<Vec<u8>> {
    let response = state.net.client().get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new("network", format!("HTTP {status}")));
    }
    read_capped(response, MAX_INSTALLER_BYTES, |downloaded, total| {
        let _ = on_progress.send(UpdateProgress { downloaded, total });
    })
    .await
}

/// Starts the NSIS installer: `/P` shows only a progress bar, `/UPDATE` keeps
/// the existing installation's choices, `/R` starts Ylide again afterwards.
#[cfg(windows)]
fn launch_installer(path: &Path) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let spawn = |flags: u32| std::process::Command::new(path).args(["/P", "/R", "/UPDATE"]).creation_flags(flags).spawn();
    // Outside Ylide's job object if there is one, so closing Ylide cannot end
    // the installer; jobs that forbid that get a plain start.
    spawn(CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(0))
        .map(|_| ())
        .map_err(|e| AppError::new("update_launch", format!("the installer could not be started: {e}")))
}

#[cfg(not(windows))]
fn launch_installer(_path: &Path) -> AppResult<()> {
    Err(AppError::new("update_unsupported", "on this system, install updates by hand"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, platforms: &str) -> String {
        format!(r#"{{"version":"{version}","notes":"Fixes","pub_date":"2026-10-16T12:00:00Z","platforms":{{{platforms}}}}}"#)
    }

    const WIN: &str = r#""windows-x86_64":{"signature":"sig-plain","url":"https://ylide.app/updates/plain.exe"}"#;
    const WIN_NSIS: &str = r#""windows-x86_64-nsis":{"signature":"sig-nsis","url":"https://ylide.app/updates/Ylide_0.2.0_x64-setup.exe"}"#;

    #[test]
    fn installer_names_match_the_release_script() {
        #[cfg(target_arch = "x86_64")]
        assert_eq!(installer_name("Ylide", "0.2.0"), "Ylide_0.2.0_x64-setup.exe");
        assert!(installer_name("Ylide", "1.0.0-beta.1").starts_with("Ylide_1.0.0-beta.1_"));
    }

    #[test]
    fn offers_only_newer_versions() {
        let body = manifest("0.2.0", WIN_NSIS);
        assert!(evaluate(&body, "0.2.0", "windows-x86_64").unwrap().is_none());
        assert!(evaluate(&body, "0.3.0", "windows-x86_64").unwrap().is_none());
        let found = evaluate(&body, "0.1.9", "windows-x86_64").unwrap().unwrap();
        assert_eq!(found.pending.version, "0.2.0");
        assert_eq!(found.notes.as_deref(), Some("Fixes"));
        // A leading "v" is accepted, and prereleases sort before the release.
        assert!(evaluate(&manifest("v0.2.0", WIN_NSIS), "0.2.0-beta.1", "windows-x86_64").unwrap().is_some());
    }

    #[test]
    fn prefers_the_nsis_entry_and_reports_missing_builds() {
        let both = manifest("0.2.0", &format!("{WIN},{WIN_NSIS}"));
        let found = evaluate(&both, "0.1.0", "windows-x86_64").unwrap().unwrap();
        assert_eq!(found.pending.signature, "sig-nsis");
        let plain = evaluate(&manifest("0.2.0", WIN), "0.1.0", "windows-x86_64").unwrap().unwrap();
        assert_eq!(plain.pending.signature, "sig-plain");
        let err = evaluate(&manifest("0.2.0", WIN), "0.1.0", "darwin-aarch64").unwrap_err();
        assert!(err.contains("darwin-aarch64"), "{err}");
    }

    #[test]
    fn rejects_broken_update_files() {
        assert!(evaluate("<html>parked domain</html>", "0.1.0", "windows-x86_64").is_err());
        assert!(evaluate(&manifest("latest", WIN), "0.1.0", "windows-x86_64").is_err());
        // Build metadata would let "0.2.0+1" pass as newer than 0.2.0.
        assert!(evaluate(&manifest("0.2.0+1", WIN), "0.2.0", "windows-x86_64").is_err());
    }

    #[test]
    fn installer_must_be_an_https_exe() {
        check_installer_url("https://ylide.app/updates/Ylide_0.2.0_x64-setup.exe").unwrap();
        assert_eq!(check_installer_url("http://ylide.app/updates/a.exe").unwrap_err().code, "update_format");
        assert_eq!(check_installer_url("https://ylide.app/updates/a.zip").unwrap_err().code, "update_format");
        assert_eq!(check_installer_url("not a url").unwrap_err().code, "update_format");
    }

    /// Run by scripts/release.mjs before publishing: the installer named in
    /// YLIDE_RELEASE_INSTALLER must carry a signature the app accepts.
    #[test]
    #[ignore = "needs a built installer; run by scripts/release.mjs"]
    fn release_installer_is_signed_with_the_app_key() {
        let installer = std::env::var("YLIDE_RELEASE_INSTALLER").expect("YLIDE_RELEASE_INSTALLER");
        let data = std::fs::read(&installer).unwrap();
        let signature = std::fs::read_to_string(format!("{installer}.sig")).unwrap();
        let name = Path::new(&installer).file_name().unwrap().to_string_lossy().into_owned();
        signing::verify(&data, &signature, &name).expect("the installer's signature does not match the key built into the app");
    }

    #[test]
    fn platform_key_uses_tauri_names() {
        let key = platform_key();
        assert!(!key.starts_with("macos"));
        assert!(key.contains('-'));
        #[cfg(all(windows, target_arch = "x86_64"))]
        assert_eq!(key, "windows-x86_64");
    }
}
