//! One-time move of the per-user folders to the new app identifier.
//!
//! The app used to be called Anyon, with the identifier `dev.anyon.ide`; it is
//! now Ylide (`app.ylide`). Tauri derives every per-user folder from the
//! identifier, so without this step the app would start empty next to the
//! user's settings, models (many GB), runtimes and WebView2 profile.
//!
//! [`migrate_app_dirs`] runs first thing at startup, before Tauri creates any
//! folder (the WebView2 profile included). For each base folder (on Windows
//! `%LOCALAPPDATA%`, then `%APPDATA%`):
//!
//! * old folder there, new one missing or empty: one `rename` (same parent, so
//!   the same volume: instant, nothing is copied);
//! * new folder already has content: both stay untouched and the new one is
//!   used, so nothing is ever merged or overwritten;
//! * the rename fails (files in use, permissions): the old folder stays in use
//!   for this run through Tauri's `appDirectoriesOverride`, so no new folder
//!   is created, and the next start tries again.
//!
//! Nothing is deleted; the only removal is an empty new folder that would
//! block the rename. Afterwards [`fix_up_files`] points absolute paths in
//! `installed.json` and `settings.json` at the new folder and replaces
//! settings that still hold the previous defaults. Every step is idempotent and
//! runs on every start (it writes nothing once everything is up to date), so a
//! start that was interrupted halfway is finished by the next one.

use crate::models::InstalledModel;
use crate::settings::{self, ChatSettings, Settings};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};

/// The app identifier before the rename to Ylide.
pub const OLD_IDENTIFIER: &str = "dev.anyon.ide";
/// The default registry URL before the repository was renamed.
pub const OLD_REGISTRY_URL: &str = "https://raw.githubusercontent.com/sweeax-exe/anyon/main/registry/models.json";
const OLD_NAME: &str = "Anyon";
const NEW_NAME: &str = "Ylide";

/// A folder can be locked for a moment (virus scanner, a webview process that
/// is still shutting down), so a failed rename is retried a few times.
const RENAME_ATTEMPTS: u32 = 4;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(250);

/// The Tauri app directories (`app_*_dir`) that live in a base folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppDir {
    Config,
    Data,
    LocalData,
    Cache,
    /// A base folder of its own only on macOS (`~/Library/Logs`); elsewhere
    /// the log folder lives inside the local data folder.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Log,
}

/// A per-user base folder such as `%APPDATA%`.
#[derive(Debug, Clone)]
pub struct Base {
    pub dir: PathBuf,
    /// App directories Tauri puts in `<dir>/<identifier>`; empty for folders
    /// Tauri does not manage (the macOS WebKit store).
    pub serves: Vec<AppDir>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// No old folder: a fresh install, or migrated on an earlier start.
    NothingToMove,
    /// Moved to the new name on this start.
    Moved,
    /// Both folders exist and the new one has content: both are left alone and
    /// the new one is used.
    Conflict,
    /// The old folder could not be moved and stays in use for this run.
    KeptOld(String),
}

#[derive(Debug, Clone)]
pub struct DirMigration {
    pub old: PathBuf,
    pub new: PathBuf,
    pub serves: Vec<AppDir>,
    pub outcome: Outcome,
}

impl DirMigration {
    /// The folder the app uses on this run.
    pub fn in_use(&self) -> &Path {
        if matches!(self.outcome, Outcome::KeptOld(_)) { &self.old } else { &self.new }
    }
}

/// Migrates this machine's per-user folders to `identifier` and returns the
/// directory overrides for folders that have to stay at the old location on
/// this run. Call it before Tauri touches any app folder.
pub fn migrate_app_dirs(identifier: &str) -> Option<AppDirectoriesOverride> {
    // A second start while the app runs: the running instance owns the folders,
    // and the single-instance plugin ends this process before it creates any.
    if app_running(identifier) {
        return None;
    }
    // The old app still running holds its folders (and would recreate them on
    // exit): moving only part of them would split the user's data.
    if app_running(OLD_IDENTIFIER) {
        tracing::warn!("{OLD_NAME} is still running; close it before the first start of {NEW_NAME}");
        old_app_running_notice();
        std::process::exit(0);
    }
    migrate_in(&platform_bases(), identifier)
}

/// Whether a build of the app with this identifier is running: Tauri's
/// single-instance plugin holds the named mutex `<identifier>-sim` while it
/// runs. Only Windows has that mutex; elsewhere this answers false.
#[cfg(windows)]
pub(crate) fn app_running(identifier: &str) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    use windows::core::PCWSTR;
    let name: Vec<u16> = format!("{identifier}-sim").encode_utf16().chain(Some(0)).collect();
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) } {
        Ok(handle) => {
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub(crate) fn app_running(_identifier: &str) -> bool {
    false
}

/// Tells the user, before any window exists, to close the old app first.
#[cfg(windows)]
fn old_app_running_notice() {
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONINFORMATION, MB_OK, MessageBoxW};
    use windows::core::PCWSTR;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let text = wide(&format!(
        "{OLD_NAME} läuft noch. Schließe {OLD_NAME} und starte {NEW_NAME} danach neu, damit deine Modelle und Einstellungen übernommen werden.\n\n\
         {OLD_NAME} is still running. Close it and start {NEW_NAME} again so your models and settings move over."
    ));
    let title = wide(NEW_NAME);
    unsafe {
        MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONINFORMATION);
    }
}

#[cfg(not(windows))]
fn old_app_running_notice() {}

/// [`migrate_app_dirs`] for the given base folders: move, fix up, log.
fn migrate_in(bases: &[Base], identifier: &str) -> Option<AppDirectoriesOverride> {
    if identifier == OLD_IDENTIFIER {
        return None;
    }
    let moves = migrate_bases(bases, OLD_IDENTIFIER, identifier);
    let mut log = Vec::new();
    for m in &moves {
        let (old, new) = (m.old.display(), m.new.display());
        match &m.outcome {
            Outcome::NothingToMove => {}
            Outcome::Moved => {
                tracing::info!("moved {old} to {new}");
                log.push(format!("moved {old} to {new}"));
            }
            Outcome::Conflict => {
                let msg = format!("{old} and {new} both exist and {new} is not empty; left both alone and using {new}");
                tracing::warn!("{msg}");
                log.push(msg);
            }
            Outcome::KeptOld(reason) => {
                let msg = format!("{reason}; using {old} for this run, the next start tries again");
                tracing::warn!("{msg}");
                log.push(msg);
            }
        }
    }
    let find = |dir: AppDir| moves.iter().find(|m| m.serves.contains(&dir));
    // Paths are rewritten for every folder that is gone (moved now or on an
    // earlier start); the previous defaults are refreshed only on the start
    // that moved something, so a value the user sets back later stays.
    let pairs: Vec<(&Path, &Path)> = moves.iter().filter(|m| !m.old.exists()).map(|m| (m.old.as_path(), m.new.as_path())).collect();
    let moved_now = moves.iter().any(|m| m.outcome == Outcome::Moved);
    if let (Some(config), Some(local)) = (find(AppDir::Config), find(AppDir::LocalData)) {
        for note in fix_up_files(config.in_use(), &local.in_use().join("models"), &pairs, moved_now) {
            tracing::info!("{note}");
            log.push(note);
        }
        write_log(local.in_use(), &log);
    }
    overrides(&moves)
}

/// The base folders Tauri puts app folders in, resolved with the same `dirs`
/// calls as Tauri's `PathResolver` and deduplicated (on Windows the cache and
/// local data share `%LOCALAPPDATA%`, config and data share `%APPDATA%`).
/// The local data folder comes first: it holds the large files and the
/// WebView2 profile, so it is the one most likely to be locked.
fn platform_bases() -> Vec<Base> {
    let mut bases: Vec<Base> = Vec::new();
    let mut add = |dir: Option<PathBuf>, serves: Option<AppDir>| {
        let Some(dir) = dir else { return };
        match bases.iter_mut().find(|b| b.dir == dir) {
            Some(b) => b.serves.extend(serves),
            None => bases.push(Base {
                dir,
                serves: serves.into_iter().collect(),
            }),
        }
    };
    add(dirs::data_local_dir(), Some(AppDir::LocalData));
    add(dirs::cache_dir(), Some(AppDir::Cache));
    add(dirs::data_dir(), Some(AppDir::Data));
    add(dirs::config_dir(), Some(AppDir::Config));
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        add(Some(home.join("Library/Logs")), Some(AppDir::Log));
        // WKWebView keeps the web storage under the bundle identifier.
        add(Some(home.join("Library/WebKit")), None);
    }
    bases
}

/// Moves `<base>/<old_id>` to `<base>/<new_id>` for every base, in order.
pub fn migrate_bases(bases: &[Base], old_id: &str, new_id: &str) -> Vec<DirMigration> {
    bases
        .iter()
        .map(|b| {
            let (old, new) = (b.dir.join(old_id), b.dir.join(new_id));
            let outcome = move_dir(&old, &new);
            DirMigration {
                old,
                new,
                serves: b.serves.clone(),
                outcome,
            }
        })
        .collect()
}

/// Renames `old` to `new` unless that could lose or mix up data.
pub fn move_dir(old: &Path, new: &Path) -> Outcome {
    match std::fs::metadata(old) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Outcome::NothingToMove,
        Err(e) => return Outcome::KeptOld(format!("cannot read {}: {e}", old.display())),
        // Not a folder of ours.
        Ok(m) if !m.is_dir() => return Outcome::NothingToMove,
        Ok(_) => {}
    }
    match std::fs::symlink_metadata(new) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Outcome::KeptOld(format!("cannot read {}: {e}", new.display())),
        Ok(m) if m.is_dir() => match is_empty_dir(new) {
            // Removed first so the move behaves the same everywhere (POSIX and
            // older Windows refuse to rename onto a folder; newer Rust on
            // Windows replaces it). Files at `new` are never replaced: see below.
            Ok(true) => {
                if let Err(e) = std::fs::remove_dir(new) {
                    return Outcome::KeptOld(format!("cannot replace the empty folder {}: {e}", new.display()));
                }
            }
            Ok(false) => return Outcome::Conflict,
            Err(e) => return Outcome::KeptOld(format!("cannot read {}: {e}", new.display())),
        },
        // A link the user set up: use it if it leads to their data, never replace it.
        Ok(m) if m.file_type().is_symlink() && new.is_dir() => {
            return if is_empty_dir(new).unwrap_or(true) {
                Outcome::KeptOld(format!("{} is a link to an empty folder", new.display()))
            } else {
                Outcome::Conflict
            };
        }
        Ok(_) => return Outcome::KeptOld(format!("{} exists and is not a folder", new.display())),
    }
    let mut attempt = 1;
    loop {
        match std::fs::rename(old, new) {
            Ok(()) => return Outcome::Moved,
            // Another instance starting at the same moment moved it already.
            Err(_) if !old.exists() && new.is_dir() => return Outcome::NothingToMove,
            Err(e) if attempt >= RENAME_ATTEMPTS || e.kind() == io::ErrorKind::NotFound => {
                return Outcome::KeptOld(format!("could not move {} to {}: {e}", old.display(), new.display()));
            }
            Err(_) => {
                attempt += 1;
                std::thread::sleep(RENAME_RETRY_DELAY);
            }
        }
    }
}

fn is_empty_dir(dir: &Path) -> io::Result<bool> {
    Ok(std::fs::read_dir(dir)?.next().is_none())
}

/// Tauri directory overrides that keep the old folders in use where the move
/// failed, so Tauri (settings, window state, WebView2 profile) and the app
/// stay together in one place and no half-empty new folder is created.
pub fn overrides(moves: &[DirMigration]) -> Option<AppDirectoriesOverride> {
    let mut o = AppDirectoryOverrides::default();
    let mut any = false;
    for m in moves.iter().filter(|m| matches!(m.outcome, Outcome::KeptOld(_))) {
        for dir in &m.serves {
            any = true;
            let path = Some(m.old.clone());
            match dir {
                AppDir::Config => o.config = path,
                AppDir::Data => o.data = path,
                AppDir::LocalData => {
                    // Tauri's default log folder lives inside it (except on macOS).
                    if !cfg!(target_os = "macos") {
                        o.log = Some(m.old.join("logs"));
                    }
                    o.local_data = path;
                }
                AppDir::Cache => o.cache = path,
                AppDir::Log => o.log = path,
            }
        }
    }
    any.then_some(AppDirectoriesOverride::Directories(o))
}

/// Updates what still refers to the old name: absolute paths into a moved
/// folder (`settings.json` `models.dir`, the file paths in every
/// `installed.json` the app reads) for each `(old, new)` pair, and, when
/// `refresh_defaults` is set, settings that still hold the previous defaults.
/// Writes only files that change; returns what it did.
pub fn fix_up_files(config_dir: &Path, default_models: &Path, moved: &[(&Path, &Path)], refresh_defaults: bool) -> Vec<String> {
    let mut notes = Vec::new();
    let mut models_dirs = vec![default_models.to_path_buf()];
    if let Some(mut s) = read_settings(config_dir) {
        let changed = fix_up_settings(&mut s, moved, refresh_defaults);
        if !changed.is_empty() {
            match s.save(config_dir) {
                Ok(()) => notes.push(format!("settings.json: updated {}", changed.join(", "))),
                Err(e) => notes.push(format!("could not update settings.json: {e}")),
            }
        }
        let dir = s.models_dir(default_models);
        if !models_dirs.contains(&dir) {
            models_dirs.push(dir);
        }
    }
    for dir in models_dirs {
        match fix_up_manifest(&dir, moved) {
            Ok(0) => {}
            Ok(n) => notes.push(format!("{}: updated {n} file path(s) to the new folder", dir.join("installed.json").display())),
            Err(e) => notes.push(format!("could not update {}: {e}", dir.join("installed.json").display())),
        }
    }
    notes
}

fn read_settings(config_dir: &Path) -> Option<Settings> {
    let text = std::fs::read_to_string(Settings::file(config_dir)).ok()?;
    // A broken file is left for `Settings::load`, which keeps a copy of it.
    serde_json::from_str(&text).ok()
}

/// Returns the names of the settings it changed.
fn fix_up_settings(s: &mut Settings, moved: &[(&Path, &Path)], refresh_defaults: bool) -> Vec<&'static str> {
    let mut changed = Vec::new();
    if let Some(dir) = &s.models.dir
        && let Some(path) = relocate_any(dir, moved)
    {
        s.models.dir = Some(path);
        changed.push("models.dir");
    }
    if !refresh_defaults {
        return changed;
    }
    if s.network.registry_url == OLD_REGISTRY_URL {
        s.network.registry_url = settings::DEFAULT_REGISTRY_URL.into();
        changed.push("network.registryUrl");
    }
    let chat = ChatSettings::default();
    if refresh_default(&mut s.chat.system_prompt, &chat.system_prompt) {
        changed.push("chat.systemPrompt");
    }
    if refresh_default(&mut s.chat.inline_prompt, &chat.inline_prompt) {
        changed.push("chat.inlinePrompt");
    }
    let d = agent::PromptTemplates::default();
    let t = &mut s.agent.templates;
    for (name, value, default) in [
        ("agent.templates.planner", &mut t.planner, &d.planner),
        ("agent.templates.coderTask", &mut t.coder_task, &d.coder_task),
        ("agent.templates.reviewerTask", &mut t.reviewer_task, &d.reviewer_task),
        ("agent.templates.feedback", &mut t.feedback, &d.feedback),
        ("agent.templates.question", &mut t.question, &d.question),
        ("agent.templates.continue", &mut t.continue_, &d.continue_),
        ("agent.templates.repeatedFailure", &mut t.repeated_failure, &d.repeated_failure),
    ] {
        if refresh_default(value, default) {
            changed.push(name);
        }
    }
    let defaults = agent::default_roles();
    for role in &mut s.agent.roles {
        let Some(d) = defaults.iter().find(|d| d.id == role.id) else { continue };
        let prompt = refresh_default(&mut role.system_prompt, &d.system_prompt);
        let description = refresh_default(&mut role.description, &d.description);
        if prompt || description {
            changed.push("agent.roles");
        }
    }
    changed.dedup();
    changed
}

/// Replaces `value` with `default` if it is still exactly the previous default,
/// i.e. the same text with the old product name. Edited text stays as it is.
pub fn refresh_default(value: &mut String, default: &str) -> bool {
    let previous = default.replace(NEW_NAME, OLD_NAME);
    if previous != default && value.replace("\r\n", "\n") == previous.replace("\r\n", "\n") {
        *value = default.to_string();
        true
    } else {
        false
    }
}

/// Rewrites the file paths in `<models_dir>/installed.json`; returns how many.
fn fix_up_manifest(models_dir: &Path, moved: &[(&Path, &Path)]) -> io::Result<usize> {
    let path = models_dir.join("installed.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut list: Vec<InstalledModel> = serde_json::from_str(&text).map_err(io::Error::other)?;
    let mut count = 0;
    for file in list.iter_mut().flat_map(|m| m.files.iter_mut().chain(m.projector.as_mut())) {
        if let Some(path) = relocate_any(&file.path, moved) {
            file.path = path;
            count += 1;
        }
    }
    if count > 0 {
        let tmp = models_dir.join("installed.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&list)?)?;
        std::fs::rename(tmp, &path)?;
    }
    Ok(count)
}

/// [`relocate`] against every moved folder; the first match wins.
fn relocate_any(path: &str, moved: &[(&Path, &Path)]) -> Option<String> {
    moved.iter().find_map(|(old, new)| relocate(path, old, new))
}

/// The new location of `path` if it pointed into the old folder that was moved
/// to `new_base`. Paths outside the old folder, and paths that still exist
/// (both folders kept), stay as they are. Windows compares case-insensitively.
pub fn relocate(path: &str, old_base: &Path, new_base: &Path) -> Option<String> {
    relocate_with(path, old_base, new_base, cfg!(windows))
}

fn relocate_with(path: &str, old_base: &Path, new_base: &Path, ignore_case: bool) -> Option<String> {
    let mut rest = Path::new(path).components();
    for want in old_base.components() {
        let got = rest.next()?;
        let same = if ignore_case {
            got.as_os_str().to_string_lossy().to_lowercase() == want.as_os_str().to_string_lossy().to_lowercase()
        } else {
            got == want
        };
        if !same {
            return None;
        }
    }
    if Path::new(path).exists() {
        return None;
    }
    let mut moved = new_base.to_path_buf();
    moved.extend(rest);
    (!old_base.exists() || moved.exists()).then(|| moved.display().to_string())
}

/// Appends what happened to `<local data>/logs/migration.log`: release builds
/// have no console, and this is the one place a user can look it up.
fn write_log(local_dir: &Path, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    let dir = local_dir.join("logs");
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let text: String = lines.iter().map(|l| format!("[unix {secs}] {l}\n")).collect();
    let result = std::fs::create_dir_all(&dir).and_then(|()| {
        std::fs::OpenOptions::new().create(true).append(true).open(dir.join("migration.log"))?.write_all(text.as_bytes())
    });
    if let Err(e) = result {
        tracing::warn!("could not write migration.log: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::InstalledFile;

    const NEW_ID: &str = "app.ylide";

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn base(dir: &Path, serves: &[AppDir]) -> Base {
        std::fs::create_dir_all(dir).unwrap();
        Base {
            dir: dir.to_path_buf(),
            serves: serves.to_vec(),
        }
    }

    fn manifest(models_dir: &Path, paths: &[String]) {
        let list = vec![InstalledModel {
            model_id: "m".into(),
            quant: "Q4".into(),
            name: "M".into(),
            files: paths
                .iter()
                .map(|p| InstalledFile {
                    path: p.clone(),
                    size_bytes: 1,
                    sha256: None,
                })
                .collect(),
            installed_at_unix_ms: 0,
            custom: false,
            projector: None,
        }];
        write(&models_dir.join("installed.json"), &serde_json::to_string_pretty(&list).unwrap());
    }

    fn manifest_paths(models_dir: &Path) -> Vec<String> {
        let list: Vec<InstalledModel> = serde_json::from_str(&read(&models_dir.join("installed.json"))).unwrap();
        list.into_iter().flat_map(|m| m.files).map(|f| f.path).collect()
    }

    #[test]
    fn the_app_uses_a_new_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
        assert_ne!(settings::DEFAULT_REGISTRY_URL, OLD_REGISTRY_URL);
        // The refresh of the chat prompt relies on the name being in it.
        assert!(ChatSettings::default().system_prompt.contains(NEW_NAME));
    }

    #[test]
    fn moves_the_old_folder_when_the_new_one_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData, AppDir::Cache]);
        let old = local.dir.join(OLD_IDENTIFIER);
        write(&old.join("models/installed.json"), "[]");
        write(&old.join("EBWebView/Default/Preferences"), "{}");

        let moves = migrate_bases(std::slice::from_ref(&local), OLD_IDENTIFIER, NEW_ID);
        assert_eq!(moves[0].outcome, Outcome::Moved);
        assert!(!old.exists());
        let new = local.dir.join(NEW_ID);
        assert_eq!(moves[0].in_use(), new);
        assert_eq!(read(&new.join("models/installed.json")), "[]");
        assert_eq!(read(&new.join("EBWebView/Default/Preferences")), "{}");
        assert!(overrides(&moves).is_none());
    }

    #[test]
    fn moves_into_an_empty_new_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let roaming = base(&tmp.path().join("Roaming"), &[AppDir::Config, AppDir::Data]);
        write(&roaming.dir.join(OLD_IDENTIFIER).join("settings.json"), "{}");
        std::fs::create_dir_all(roaming.dir.join(NEW_ID)).unwrap();

        let moves = migrate_bases(std::slice::from_ref(&roaming), OLD_IDENTIFIER, NEW_ID);
        assert_eq!(moves[0].outcome, Outcome::Moved);
        assert_eq!(read(&roaming.dir.join(NEW_ID).join("settings.json")), "{}");
        assert!(!roaming.dir.join(OLD_IDENTIFIER).exists());
    }

    #[test]
    fn leaves_both_alone_when_the_new_folder_has_content() {
        let tmp = tempfile::tempdir().unwrap();
        let roaming = base(&tmp.path().join("Roaming"), &[AppDir::Config]);
        let (old, new) = (roaming.dir.join(OLD_IDENTIFIER), roaming.dir.join(NEW_ID));
        write(&old.join("settings.json"), "old");
        write(&new.join("settings.json"), "new");

        let moves = migrate_bases(&[roaming], OLD_IDENTIFIER, NEW_ID);
        assert_eq!(moves[0].outcome, Outcome::Conflict);
        assert_eq!(moves[0].in_use(), new);
        assert_eq!(read(&old.join("settings.json")), "old");
        assert_eq!(read(&new.join("settings.json")), "new");
        assert!(overrides(&moves).is_none(), "the new folder is used");
    }

    #[test]
    fn is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData]);
        write(&local.dir.join(OLD_IDENTIFIER).join("models/a.gguf"), "GGUF");

        assert_eq!(migrate_bases(std::slice::from_ref(&local), OLD_IDENTIFIER, NEW_ID)[0].outcome, Outcome::Moved);
        for _ in 0..2 {
            let moves = migrate_bases(std::slice::from_ref(&local), OLD_IDENTIFIER, NEW_ID);
            assert_eq!(moves[0].outcome, Outcome::NothingToMove);
            assert!(overrides(&moves).is_none());
        }
        assert_eq!(read(&local.dir.join(NEW_ID).join("models/a.gguf")), "GGUF");
        assert!(!local.dir.join(OLD_IDENTIFIER).exists());
    }

    #[test]
    fn nothing_happens_on_a_fresh_install() {
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData]);
        let moves = migrate_bases(std::slice::from_ref(&local), OLD_IDENTIFIER, NEW_ID);
        assert_eq!(moves[0].outcome, Outcome::NothingToMove);
        assert!(!local.dir.join(NEW_ID).exists(), "the migration creates no folder");
        let notes = fix_up_files(&tmp.path().join("Roaming").join(NEW_ID), &local.dir.join(NEW_ID).join("models"), &[(&moves[0].old, &moves[0].new)], false);
        assert!(notes.is_empty());
        assert!(!local.dir.join(NEW_ID).exists());
    }

    #[test]
    fn keeps_the_old_folder_in_use_when_the_target_is_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData, AppDir::Cache]);
        let (old, new) = (local.dir.join(OLD_IDENTIFIER), local.dir.join(NEW_ID));
        write(&old.join("models/a.gguf"), "GGUF");
        write(&new, "a file in the way");

        let moves = migrate_bases(&[local], OLD_IDENTIFIER, NEW_ID);
        assert!(matches!(moves[0].outcome, Outcome::KeptOld(_)), "{:?}", moves[0].outcome);
        assert_eq!(moves[0].in_use(), old);
        assert_eq!(read(&old.join("models/a.gguf")), "GGUF");
        assert_eq!(read(&new), "a file in the way", "nothing is overwritten");

        let Some(AppDirectoriesOverride::Directories(o)) = overrides(&moves) else { panic!("expected overrides") };
        assert_eq!(o.local_data.as_deref(), Some(old.as_path()));
        assert_eq!(o.cache.as_deref(), Some(old.as_path()));
        if !cfg!(target_os = "macos") {
            assert_eq!(o.log, Some(old.join("logs")));
        }
        assert_eq!((o.config, o.data), (None, None));
    }

    #[test]
    fn keeps_the_old_folder_in_use_when_the_rename_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(OLD_IDENTIFIER);
        write(&old.join("settings.json"), "{}");
        // The target's parent does not exist, so the rename itself fails.
        let new = tmp.path().join("missing").join(NEW_ID);

        let outcome = move_dir(&old, &new);
        assert!(matches!(&outcome, Outcome::KeptOld(reason) if reason.contains("could not move")), "{outcome:?}");
        assert_eq!(read(&old.join("settings.json")), "{}");
        assert!(!new.exists());
    }

    #[test]
    fn a_failed_folder_falls_back_alone() {
        // Roaming moves, Local is blocked: only the local directories stay old.
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData, AppDir::Cache]);
        let roaming = base(&tmp.path().join("Roaming"), &[AppDir::Data, AppDir::Config]);
        write(&local.dir.join(OLD_IDENTIFIER).join("models/a.gguf"), "GGUF");
        write(&local.dir.join(NEW_ID), "blocker");
        write(&roaming.dir.join(OLD_IDENTIFIER).join("settings.json"), "{}");

        let moves = migrate_bases(&[local.clone(), roaming.clone()], OLD_IDENTIFIER, NEW_ID);
        assert!(matches!(moves[0].outcome, Outcome::KeptOld(_)));
        assert_eq!(moves[1].outcome, Outcome::Moved);
        let Some(AppDirectoriesOverride::Directories(o)) = overrides(&moves) else { panic!("expected overrides") };
        assert_eq!(o.local_data, Some(local.dir.join(OLD_IDENTIFIER)));
        assert_eq!((o.config, o.data), (None, None), "the moved config folder is used");
    }

    #[test]
    fn relocates_paths_into_the_moved_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(NEW_ID));
        write(&new.join("models/r/a.gguf"), "GGUF");
        let inside = old.join("models").join("r").join("a.gguf").display().to_string();
        assert_eq!(relocate(&inside, &old, &new), Some(new.join("models").join("r").join("a.gguf").display().to_string()));
        // The folder itself, and files that are not there (yet): the old folder is gone.
        assert_eq!(relocate(&old.display().to_string(), &old, &new), Some(new.display().to_string()));
        assert!(relocate(&old.join("models/missing.gguf").display().to_string(), &old, &new).is_some());
        // Outside the old folder: untouched.
        let outside = tmp.path().join("elsewhere").join("a.gguf").display().to_string();
        assert_eq!(relocate(&outside, &old, &new), None);
        let sibling = tmp.path().join(format!("{OLD_IDENTIFIER}-backup")).join("a.gguf").display().to_string();
        assert_eq!(relocate(&sibling, &old, &new), None);
    }

    #[test]
    fn existing_paths_in_a_kept_old_folder_are_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(NEW_ID));
        write(&old.join("models/a.gguf"), "GGUF");
        let path = old.join("models").join("a.gguf").display().to_string();
        assert_eq!(relocate(&path, &old, &new), None);
        // Missing in both places while the old folder still exists: untouched too.
        assert_eq!(relocate(&old.join("models/b.gguf").display().to_string(), &old, &new), None);
    }

    #[test]
    fn relocation_ignores_case_on_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join("Local").join(OLD_IDENTIFIER), tmp.path().join("Local").join(NEW_ID));
        write(&new.join("models/Repo/A.gguf"), "GGUF");
        let shouted = Path::new(&old.display().to_string().to_uppercase()).join("models").join("Repo").join("A.gguf");
        let shouted = shouted.display().to_string();
        let expected = new.join("models").join("Repo").join("A.gguf").display().to_string();
        assert_eq!(relocate_with(&shouted, &old, &new, true), Some(expected.clone()), "the rest keeps its case");
        assert_eq!(relocate_with(&shouted, &old, &new, false), None);
        if cfg!(windows) {
            assert_eq!(relocate(&shouted, &old, &new), Some(expected));
        }
    }

    #[test]
    fn fix_up_rewrites_installed_json_and_the_models_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData]);
        let roaming = base(&tmp.path().join("Roaming"), &[AppDir::Config]);
        let (old_local, new_local) = (local.dir.join(OLD_IDENTIFIER), local.dir.join(NEW_ID));
        let external = tmp.path().join("D").join("my.gguf");
        write(&external, "GGUF");
        write(&old_local.join("models/r/a.gguf"), "GGUF");
        write(&old_local.join("custom-models/r/b.gguf"), "GGUF");
        let a = old_local.join("models").join("r").join("a.gguf").display().to_string();
        let b = old_local.join("custom-models").join("r").join("b.gguf").display().to_string();
        manifest(&old_local.join("models"), &[a, external.display().to_string()]);
        manifest(&old_local.join("custom-models"), &[b]);
        let s = Settings {
            models: settings::ModelSettings {
                dir: Some(old_local.join("custom-models").display().to_string()),
                ..Default::default()
            },
            ..Default::default()
        };
        s.save(&roaming.dir.join(OLD_IDENTIFIER)).unwrap();

        let moves = migrate_bases(&[local, roaming], OLD_IDENTIFIER, NEW_ID);
        assert!(moves.iter().all(|m| m.outcome == Outcome::Moved));
        let config = moves[1].in_use();
        let notes = fix_up_files(config, &new_local.join("models"), &[(&old_local, &new_local)], true);
        assert_eq!(notes.len(), 3, "{notes:?}");

        let s = Settings::load(config);
        assert_eq!(s.models.dir, Some(new_local.join("custom-models").display().to_string()));
        assert_eq!(
            manifest_paths(&new_local.join("models")),
            [new_local.join("models").join("r").join("a.gguf").display().to_string(), external.display().to_string()]
        );
        assert_eq!(manifest_paths(&new_local.join("custom-models")), [new_local.join("custom-models").join("r").join("b.gguf").display().to_string()]);
        assert!(!new_local.join("models/installed.json.tmp").exists());
        // Everything the app reads now exists.
        let store = crate::models::ModelStore::new(s.models_dir(&new_local.join("models")));
        assert_eq!(store.installed().len(), 1);

        // Idempotent: nothing left to do, nothing written.
        let before = read(&Settings::file(config));
        assert!(fix_up_files(config, &new_local.join("models"), &[(&old_local, &new_local)], true).is_empty());
        assert_eq!(read(&Settings::file(config)), before);
    }

    #[test]
    fn fix_up_refreshes_previous_defaults_and_keeps_edits() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join(NEW_ID);
        let defaults = Settings::default();
        let mut s = Settings::default();
        s.network.registry_url = OLD_REGISTRY_URL.into();
        s.chat.system_prompt = defaults.chat.system_prompt.replace("Ylide", "Anyon").replace('\n', "\r\n");
        s.chat.inline_prompt = "My own inline prompt, mentioning Anyon.".into();
        s.agent.roles[0].system_prompt = "Custom orchestrator".into();
        s.save(&config).unwrap();

        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join("new"));
        // Without a move on this start, the previous defaults stay as they are.
        assert!(fix_up_files(&config, &tmp.path().join("models"), &[(&old, &new)], false).is_empty());
        assert_eq!(Settings::load(&config).network.registry_url, OLD_REGISTRY_URL);
        let notes = fix_up_files(&config, &tmp.path().join("models"), &[(&old, &new)], true);
        assert_eq!(notes.len(), 1, "{notes:?}");
        let s = Settings::load(&config);
        assert_eq!(s.network.registry_url, settings::DEFAULT_REGISTRY_URL);
        assert_eq!(s.chat.system_prompt, defaults.chat.system_prompt);
        assert_eq!(s.chat.inline_prompt, "My own inline prompt, mentioning Anyon.");
        assert_eq!(s.agent.roles[0].system_prompt, "Custom orchestrator");
        assert_eq!(s.agent.templates, defaults.agent.templates);

        // A user's own registry URL and an edited prompt stay as they are.
        let mut s = Settings::default();
        s.network.registry_url = "https://example.org/models.json".into();
        s.chat.system_prompt = format!("{} Always answer in German.", defaults.chat.system_prompt.replace("Ylide", "Anyon"));
        s.save(&config).unwrap();
        let before = read(&Settings::file(&config));
        assert!(fix_up_files(&config, &tmp.path().join("models"), &[(&old, &new)], true).is_empty());
        assert_eq!(read(&Settings::file(&config)), before);
    }

    #[test]
    fn previous_defaults_are_recognised_exactly() {
        let default = "You are Ylide.\nBe brief.";
        let mut v = "You are Anyon.\nBe brief.".to_string();
        assert!(refresh_default(&mut v, default));
        assert_eq!(v, default);
        assert!(!refresh_default(&mut v, default), "idempotent");

        let mut edited = "You are Anyon.\nBe very brief.".to_string();
        assert!(!refresh_default(&mut edited, default));
        assert_eq!(edited, "You are Anyon.\nBe very brief.");

        // A default without the name never replaces anything.
        let mut same = "Plan the work.".to_string();
        assert!(!refresh_default(&mut same, "Plan the work."));
    }

    #[test]
    fn bases_cover_every_tauri_folder_once() {
        // Only resolves the folders, touches nothing.
        let bases = platform_bases();
        let folders: Vec<_> = bases.iter().map(|b| &b.dir).collect();
        assert!(folders.iter().enumerate().all(|(i, d)| !folders[..i].contains(d)), "deduplicated: {folders:?}");
        for dir in [AppDir::Config, AppDir::Data, AppDir::LocalData, AppDir::Cache] {
            assert_eq!(bases.iter().filter(|b| b.serves.contains(&dir)).count(), 1, "{dir:?}");
        }
        assert!(bases[0].serves.contains(&AppDir::LocalData), "the local data folder goes first");
        if cfg!(windows) {
            assert_eq!(folders, [&dirs::data_local_dir().unwrap(), &dirs::config_dir().unwrap()]);
        }
    }

    /// The layout found on a real machine: settings with the old defaults in
    /// the roaming folder; models, runtimes and the WebView2 profile locally.
    fn old_install(root: &Path) -> (Base, Base) {
        let local = base(&root.join("Local"), &[AppDir::LocalData, AppDir::Cache]);
        let roaming = base(&root.join("Roaming"), &[AppDir::Data, AppDir::Config]);
        let old_local = local.dir.join(OLD_IDENTIFIER);
        write(&old_local.join("models/unsloth__R/a.gguf"), "GGUF");
        write(&old_local.join("runtimes/b1/cuda/llama-server.exe"), "MZ");
        write(&old_local.join("EBWebView/Default/Local Storage/leveldb/CURRENT"), "x");
        manifest(&old_local.join("models"), &[old_local.join("models").join("unsloth__R").join("a.gguf").display().to_string()]);
        let mut s = Settings::default();
        s.network.registry_url = OLD_REGISTRY_URL.into();
        s.chat.system_prompt = s.chat.system_prompt.replace("Ylide", "Anyon");
        s.onboarding_done = true;
        s.save(&roaming.dir.join(OLD_IDENTIFIER)).unwrap();
        (local, roaming)
    }

    #[test]
    fn full_migration_moves_and_updates_everything_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (local, roaming) = old_install(tmp.path());
        let bases = [local.clone(), roaming.clone()];
        let (new_local, new_config) = (local.dir.join(NEW_ID), roaming.dir.join(NEW_ID));

        assert!(migrate_in(&bases, NEW_ID).is_none(), "nothing stays at the old place");
        assert!(!local.dir.join(OLD_IDENTIFIER).exists() && !roaming.dir.join(OLD_IDENTIFIER).exists());
        assert_eq!(read(&new_local.join("runtimes/b1/cuda/llama-server.exe")), "MZ");
        assert!(new_local.join("EBWebView/Default/Local Storage/leveldb/CURRENT").exists());
        let s = Settings::load(&new_config);
        assert!(s.onboarding_done);
        assert_eq!(s.network.registry_url, settings::DEFAULT_REGISTRY_URL);
        assert_eq!(s.chat.system_prompt, ChatSettings::default().system_prompt);
        let store = crate::models::ModelStore::new(new_local.join("models"));
        assert_eq!(store.installed().len(), 1, "the downloaded model is still installed");
        assert!(store.installed()[0].files[0].path.starts_with(&new_local.display().to_string()));
        let log = read(&new_local.join("logs/migration.log"));
        assert_eq!(log.lines().count(), 4, "{log}");

        // Later starts change nothing and log nothing.
        let settings_before = read(&Settings::file(&new_config));
        assert!(migrate_in(&bases, NEW_ID).is_none());
        assert_eq!(read(&Settings::file(&new_config)), settings_before);
        assert_eq!(read(&new_local.join("logs/migration.log")), log);
    }

    #[test]
    fn full_migration_falls_back_to_the_old_local_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let (local, roaming) = old_install(tmp.path());
        let old_local = local.dir.join(OLD_IDENTIFIER);
        write(&local.dir.join(NEW_ID), "blocker");
        let bases = [local.clone(), roaming.clone()];

        let Some(AppDirectoriesOverride::Directories(o)) = migrate_in(&bases, NEW_ID) else { panic!("expected overrides") };
        assert_eq!(o.local_data.as_deref(), Some(old_local.as_path()));
        assert_eq!(o.config, None, "the settings were moved");
        // The model keeps its (still valid) path, the settings got the new defaults.
        let store = crate::models::ModelStore::new(old_local.join("models"));
        assert_eq!(store.installed().len(), 1);
        assert_eq!(Settings::load(&roaming.dir.join(NEW_ID)).network.registry_url, settings::DEFAULT_REGISTRY_URL);
        assert!(read(&old_local.join("logs/migration.log")).contains("next start tries again"));

        // Once the blocker is gone, the next start moves the folder.
        std::fs::remove_file(local.dir.join(NEW_ID)).unwrap();
        assert!(migrate_in(&bases, NEW_ID).is_none());
        assert!(!old_local.exists());
        let store = crate::models::ModelStore::new(local.dir.join(NEW_ID).join("models"));
        assert_eq!(store.installed().len(), 1);
    }

    #[test]
    fn running_with_the_old_identifier_does_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (local, roaming) = old_install(tmp.path());
        assert!(migrate_in(&[local.clone(), roaming], OLD_IDENTIFIER).is_none());
        assert!(local.dir.join(OLD_IDENTIFIER).join("models/installed.json").exists());
    }

    #[test]
    fn paths_into_the_moved_roaming_folder_are_rewritten_too() {
        let tmp = tempfile::tempdir().unwrap();
        let local = base(&tmp.path().join("Local"), &[AppDir::LocalData]);
        let roaming = base(&tmp.path().join("Roaming"), &[AppDir::Config, AppDir::Data]);
        let old_roaming = roaming.dir.join(OLD_IDENTIFIER);
        write(&old_roaming.join("models/r/a.gguf"), "GGUF");
        manifest(&old_roaming.join("models"), &[old_roaming.join("models").join("r").join("a.gguf").display().to_string()]);
        let s = Settings {
            models: settings::ModelSettings {
                dir: Some(old_roaming.join("models").display().to_string()),
                ..Default::default()
            },
            ..Default::default()
        };
        s.save(&old_roaming).unwrap();

        assert!(migrate_in(&[local.clone(), roaming.clone()], NEW_ID).is_none());
        let new_roaming = roaming.dir.join(NEW_ID);
        let s = Settings::load(&new_roaming);
        assert_eq!(s.models.dir, Some(new_roaming.join("models").display().to_string()));
        let store = crate::models::ModelStore::new(s.models_dir(&local.dir.join(NEW_ID).join("models")));
        assert_eq!(store.installed().len(), 1, "the model in the roaming folder is still installed");
    }

    #[cfg(windows)]
    #[test]
    fn detects_a_running_instance_by_its_mutex() {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::PCWSTR;
        let id = format!("test.ylide.migration.{}", std::process::id());
        assert!(!app_running(&id));
        let name: Vec<u16> = format!("{id}-sim").encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) }.unwrap();
        assert!(app_running(&id));
        let _ = unsafe { CloseHandle(handle) };
        assert!(!app_running(&id));
    }

    #[test]
    fn a_broken_settings_file_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        write(&Settings::file(tmp.path()), "{ broken");
        let (old, new) = (tmp.path().join("old"), tmp.path().join("new"));
        assert!(fix_up_files(tmp.path(), &tmp.path().join("models"), &[(&old, &new)], true).is_empty());
        assert_eq!(read(&Settings::file(tmp.path())), "{ broken");
    }
}
