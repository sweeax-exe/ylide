//! The installed skills: one folder per skill (named after it) in Ylide's
//! local data folder, next to `skills.json`, which records where each skill
//! came from and whether it is on. New skills start switched off.
//!
//! Skills of the open project (`<project>/.agents/skills/<name>/SKILL.md`)
//! are read in place and never copied or changed; whether they are on is
//! kept here, per project.

use crate::frontmatter::{self, SkillMeta, reserved_on_windows};
use crate::prompt::EnabledSkill;
use crate::{Result, SkillError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

pub const SKILL_FILE: &str = "SKILL.md";
/// Where a project keeps its own skills, relative to its root.
pub const PROJECT_DIR: &str = ".agents/skills";
/// Ids of project skills start with this; installed skills go by their name.
pub const PROJECT_PREFIX: &str = "project:";
pub const MAX_FILES: usize = 300;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_SKILL_BYTES: u64 = 10 * 1024 * 1024;
const MAX_PROJECT_SKILLS: usize = 50;
const MAX_DEPTH: usize = 8;
const INDEX: &str = "skills.json";
const MB: u64 = 1024 * 1024;

/// Where an installed skill came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum SkillSource {
    /// A folder of a GitHub repository, pinned to a commit.
    #[serde(rename_all = "camelCase")]
    Github {
        /// "owner/name".
        repo: String,
        /// The branch or tag asked for; `None` follows the default branch.
        git_ref: Option<String>,
        /// The skill's folder in the repository ("" = its root).
        path: String,
        commit: String,
        /// Git tree id of that folder at the commit, to see whether it changed.
        tree: String,
    },
    /// Copied from a folder on this computer.
    #[serde(rename_all = "camelCase")]
    Folder { path: String },
    /// In the open project's `.agents/skills`, read in place.
    Project,
}

/// A skill as the Skills page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillInfo {
    /// The name for installed skills; `project:<name>` for the project's own.
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub source: SkillSource,
    pub enabled: bool,
    /// The user confirmed the content once (it is shown before the first switch-on).
    pub reviewed: bool,
    #[ts(type = "number")]
    pub installed_at_unix_ms: u64,
    pub files: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    /// Why the skill cannot be used right now (its SKILL.md is broken or gone).
    pub error: Option<String>,
}

/// SKILL.md in full and the skill's other files, for "View content".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillContent {
    pub text: String,
    pub files: Vec<String>,
}

/// What an update would change, shown before it is installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillUpdate {
    pub name: String,
    /// The commit the update installs (GitHub); empty for a folder.
    pub commit: String,
    pub up_to_date: bool,
    pub version: Option<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    /// Unified diff of SKILL.md; empty when it did not change.
    pub diff: String,
}

/// The open project: its folder and the short key its state is kept under.
#[derive(Debug, Clone, Copy)]
pub struct Project<'a> {
    pub root: &'a Path,
    pub key: &'a str,
}

/// One file of a skill being installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFile {
    /// Relative to the skill's folder, with '/'.
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    source: SkillSource,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    reviewed: bool,
    #[serde(default)]
    installed_at_unix_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProjectState {
    enabled: BTreeSet<String>,
    reviewed: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Index {
    version: u32,
    skills: Vec<Entry>,
    /// By project key.
    projects: BTreeMap<String, ProjectState>,
}

impl Default for Index {
    fn default() -> Self {
        Self { version: 1, skills: vec![], projects: BTreeMap::new() }
    }
}

pub struct SkillStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl SkillStore {
    /// The store in `dir`; leftovers of an interrupted install are removed.
    pub fn new(dir: PathBuf) -> Self {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".staging-") || name.starts_with(".old-") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Self { dir, lock: Mutex::new(()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Installed skills by name, then the project's skills.
    pub fn list(&self, project: Option<Project<'_>>) -> Vec<SkillInfo> {
        let index = self.read_index();
        let mut out: Vec<SkillInfo> = index.skills.iter().map(|e| self.installed_info(e)).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(p) = project {
            let state = index.projects.get(p.key).cloned().unwrap_or_default();
            out.extend(project_skills(p.root).into_iter().map(|f| f.info(&state)));
        }
        out
    }

    /// The skills that are on and readable, for prompts and `skill_read`. A
    /// project skill with the name of an installed one is left out.
    pub fn enabled(&self, project: Option<Project<'_>>) -> Vec<EnabledSkill> {
        let index = self.read_index();
        let mut out: Vec<EnabledSkill> = index
            .skills
            .iter()
            .filter(|e| e.enabled)
            .filter_map(|e| {
                let dir = self.dir.join(&e.name);
                let meta = read_meta(&dir).ok()?;
                Some(EnabledSkill { name: e.name.clone(), description: meta.description, dir })
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(p) = project {
            let state = index.projects.get(p.key).cloned().unwrap_or_default();
            for found in project_skills(p.root) {
                if let Ok(meta) = found.meta
                    && state.enabled.contains(&found.name)
                    && !out.iter().any(|s| s.name == found.name)
                {
                    out.push(EnabledSkill { name: found.name, description: meta.description, dir: found.dir });
                }
            }
        }
        out
    }

    /// Switches a skill on or off; switching on also records that the user
    /// confirmed its content.
    pub fn set_enabled(&self, id: &str, on: bool, project: Option<Project<'_>>) -> Result<()> {
        let _guard = self.guard();
        let mut index = self.read_index();
        if let Some(name) = id.strip_prefix(PROJECT_PREFIX) {
            let p = project.ok_or_else(|| SkillError::NotFound(id.to_string()))?;
            if !project_skills(p.root).iter().any(|f| f.name == name && f.meta.is_ok()) {
                return Err(SkillError::NotFound(id.to_string()));
            }
            let state = index.projects.entry(p.key.to_string()).or_default();
            if on {
                state.enabled.insert(name.to_string());
                state.reviewed.insert(name.to_string());
            } else {
                state.enabled.remove(name);
            }
        } else {
            let entry = index.skills.iter_mut().find(|e| e.name == id).ok_or_else(|| SkillError::NotFound(id.to_string()))?;
            entry.enabled = on;
            entry.reviewed |= on;
        }
        self.write_index(&index)
    }

    /// Removes an installed skill with its files.
    pub fn remove(&self, name: &str) -> Result<()> {
        let _guard = self.guard();
        let mut index = self.read_index();
        let before = index.skills.len();
        index.skills.retain(|e| e.name != name);
        if index.skills.len() == before || !frontmatter::valid_name(name) {
            return Err(SkillError::NotFound(name.to_string()));
        }
        self.write_index(&index)?;
        match std::fs::remove_dir_all(self.dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    /// The full SKILL.md and the list of files, for "View content".
    pub fn content(&self, id: &str, project: Option<Project<'_>>) -> Result<SkillContent> {
        let dir = self.dir_of(id, project)?;
        let text = read_text(&dir.join(SKILL_FILE), frontmatter::MAX_SKILL_MD_BYTES as u64)?;
        Ok(SkillContent { text, files: files(&dir).into_iter().map(|(rel, _)| rel).collect() })
    }

    /// Where an installed skill came from.
    pub fn source(&self, name: &str) -> Result<SkillSource> {
        self.read_index().skills.into_iter().find(|e| e.name == name).map(|e| e.source).ok_or_else(|| SkillError::NotFound(name.to_string()))
    }

    /// Names of the installed skills.
    pub fn installed_names(&self) -> BTreeSet<String> {
        self.read_index().skills.into_iter().map(|e| e.name).collect()
    }

    /// Installs new skills, switched off. All are checked first, so either
    /// all are installed or none is.
    pub fn install(&self, skills: Vec<(Vec<SkillFile>, SkillSource)>) -> Result<Vec<SkillInfo>> {
        let checked = skills.into_iter().map(|(files, source)| check(files).map(|(meta, files)| (meta, files, source))).collect::<Result<Vec<_>>>()?;
        let _guard = self.guard();
        let mut index = self.read_index();
        let mut names = BTreeSet::new();
        for (meta, _, _) in &checked {
            if index.skills.iter().any(|e| e.name == meta.name) || !names.insert(meta.name.clone()) {
                return Err(SkillError::Exists(meta.name.clone()));
            }
        }
        let mut added = Vec::new();
        for (meta, files, source) in checked {
            self.write_folder(&meta.name, &files)?;
            let entry = Entry { name: meta.name, source, enabled: false, reviewed: false, installed_at_unix_ms: now_ms() };
            index.skills.push(entry.clone());
            added.push(entry);
        }
        self.write_index(&index)?;
        Ok(added.iter().map(|e| self.installed_info(e)).collect())
    }

    /// What installing `files` over the skill `name` would change.
    pub fn compare(&self, name: &str, files: Vec<SkillFile>, commit: &str) -> Result<SkillUpdate> {
        let (meta, files) = check(files)?;
        if meta.name != name {
            return Err(SkillError::Renamed { old: name.to_string(), new: meta.name });
        }
        let dir = self.dir_of(name, None)?;
        let old: BTreeMap<String, PathBuf> = walk(&dir, MAX_FILES).into_iter().map(|(rel, path, _)| (rel, path)).collect();
        let (mut added, mut changed) = (Vec::new(), Vec::new());
        for f in &files {
            match old.get(&f.path) {
                None => added.push(f.path.clone()),
                Some(path) if std::fs::read(path).ok().as_deref() != Some(f.bytes.as_slice()) => changed.push(f.path.clone()),
                Some(_) => {}
            }
        }
        let new: BTreeSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
        let removed: Vec<String> = old.keys().filter(|rel| !new.contains(rel.as_str())).cloned().collect();
        let diff = if changed.iter().any(|p| p == SKILL_FILE) {
            let before = std::fs::read_to_string(dir.join(SKILL_FILE)).unwrap_or_default();
            let after = files.iter().find(|f| f.path == SKILL_FILE).map(|f| String::from_utf8_lossy(&f.bytes).into_owned()).unwrap_or_default();
            unified_diff(&before, &after)
        } else {
            String::new()
        };
        Ok(SkillUpdate {
            name: name.to_string(),
            commit: commit.to_string(),
            up_to_date: added.is_empty() && removed.is_empty() && changed.is_empty(),
            version: meta.version,
            added,
            removed,
            changed,
            diff,
        })
    }

    /// Replaces an installed skill's files with a newer version; whether it is
    /// on stays as it was.
    pub fn update(&self, name: &str, files: Vec<SkillFile>, source: SkillSource) -> Result<SkillInfo> {
        let (meta, files) = check(files)?;
        if meta.name != name {
            return Err(SkillError::Renamed { old: name.to_string(), new: meta.name });
        }
        let _guard = self.guard();
        let mut index = self.read_index();
        let entry = index.skills.iter_mut().find(|e| e.name == name).ok_or_else(|| SkillError::NotFound(name.to_string()))?;
        self.write_folder(name, &files)?;
        entry.source = source;
        entry.installed_at_unix_ms = now_ms();
        let entry = entry.clone();
        self.write_index(&index)?;
        Ok(self.installed_info(&entry))
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn dir_of(&self, id: &str, project: Option<Project<'_>>) -> Result<PathBuf> {
        if let Some(name) = id.strip_prefix(PROJECT_PREFIX) {
            let p = project.ok_or_else(|| SkillError::NotFound(id.to_string()))?;
            return project_skills(p.root).into_iter().find(|f| f.name == name).map(|f| f.dir).ok_or_else(|| SkillError::NotFound(id.to_string()));
        }
        if !frontmatter::valid_name(id) || !self.read_index().skills.iter().any(|e| e.name == id) {
            return Err(SkillError::NotFound(id.to_string()));
        }
        Ok(self.dir.join(id))
    }

    fn installed_info(&self, e: &Entry) -> SkillInfo {
        let dir = self.dir.join(&e.name);
        info(e.name.clone(), e.name.clone(), &dir, read_meta(&dir).map_err(|err| err.to_string()), e.source.clone(), (e.enabled, e.reviewed), e.installed_at_unix_ms)
    }

    fn read_index(&self) -> Index {
        let path = self.dir.join(INDEX);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                // Kept for the user to look at; the skills' folders stay.
                let _ = std::fs::rename(&path, path.with_extension("json.broken"));
                Index::default()
            }),
            Err(_) => Index::default(),
        }
    }

    fn write_index(&self, index: &Index) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(INDEX);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(index).expect("the index is plain data"))?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Writes the files into a new folder first and swaps it in, so a failed
    /// install never leaves half a skill.
    fn write_folder(&self, name: &str, files: &[SkillFile]) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let stamp = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        let staging = self.dir.join(format!(".staging-{name}-{stamp}"));
        let written = files.iter().try_for_each(|f| {
            let path = staging.join(&f.path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, &f.bytes)
        });
        if let Err(e) = written {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e.into());
        }
        let target = self.dir.join(name);
        let old = self.dir.join(format!(".old-{name}-{stamp}"));
        let replacing = target.exists();
        if replacing && let Err(e) = std::fs::rename(&target, &old) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e.into());
        }
        if let Err(e) = std::fs::rename(&staging, &target) {
            if replacing {
                let _ = std::fs::rename(&old, &target);
            }
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e.into());
        }
        if replacing {
            let _ = std::fs::remove_dir_all(&old);
        }
        Ok(())
    }
}

fn info(id: String, name: String, dir: &Path, meta: std::result::Result<SkillMeta, String>, source: SkillSource, (enabled, reviewed): (bool, bool), at: u64) -> SkillInfo {
    let listed = walk(dir, MAX_FILES);
    let (description, version, license, error) = match meta {
        Ok(m) => (m.description, m.version, m.license, None),
        Err(e) => (String::new(), None, None, Some(e)),
    };
    SkillInfo {
        id,
        name,
        description,
        version,
        license,
        source,
        enabled,
        reviewed,
        installed_at_unix_ms: at,
        files: listed.len() as u32,
        bytes: listed.iter().map(|(_, _, size)| size).sum(),
        error,
    }
}

/// A skill in the project's `.agents/skills`.
struct ProjectSkill {
    name: String,
    dir: PathBuf,
    meta: std::result::Result<SkillMeta, String>,
}

impl ProjectSkill {
    fn info(self, state: &ProjectState) -> SkillInfo {
        let flags = (state.enabled.contains(&self.name) && self.meta.is_ok(), state.reviewed.contains(&self.name));
        info(format!("{PROJECT_PREFIX}{}", self.name), self.name, &self.dir, self.meta, SkillSource::Project, flags, 0)
    }
}

/// The project's own skills, sorted by name; folders that are links are skipped.
fn project_skills(root: &Path) -> Vec<ProjectSkill> {
    let base = PROJECT_DIR.split('/').fold(root.to_path_buf(), |p, part| p.join(part));
    let mut out: Vec<ProjectSkill> = Vec::new();
    for dir in subfolders(&base).into_iter().take(MAX_PROJECT_SKILLS) {
        let file = dir.join(SKILL_FILE);
        if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let meta = read_meta(&dir).map_err(|e| e.to_string());
        let name = meta.as_ref().map_or(folder, |m| m.name.clone());
        if !out.iter().any(|s| s.name == name) {
            out.push(ProjectSkill { name, dir, meta });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Real subfolders (no links), sorted.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<PathBuf> = entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
    out.sort();
    out
}

/// The skill folders in `dir`: `dir` itself when it has a SKILL.md, else its
/// subfolders that have one, also below `.agents/skills`, `.claude/skills`
/// and `skills` (a repository checked out by hand).
pub fn skill_folders(dir: &Path) -> Vec<PathBuf> {
    if dir.join(SKILL_FILE).is_file() {
        return vec![dir.to_path_buf()];
    }
    let mut out = Vec::new();
    for base in [dir.to_path_buf(), dir.join(".agents").join("skills"), dir.join(".claude").join("skills"), dir.join("skills")] {
        out.extend(subfolders(&base).into_iter().filter(|sub| sub.join(SKILL_FILE).is_file()));
    }
    out.sort();
    out.dedup();
    out
}

/// The files of a skill folder on this computer, within the limits.
pub fn read_folder(dir: &Path) -> Result<Vec<SkillFile>> {
    let listed = walk(dir, MAX_FILES);
    if listed.len() > MAX_FILES {
        return Err(SkillError::TooLarge(format!("the skill has more than {MAX_FILES} files")));
    }
    let mut total = 0;
    listed
        .into_iter()
        .map(|(path, file, size)| {
            total += size;
            if size > MAX_FILE_BYTES {
                return Err(SkillError::TooLarge(format!("{path} is larger than {} MB", MAX_FILE_BYTES / MB)));
            }
            if total > MAX_SKILL_BYTES {
                return Err(SkillError::TooLarge(format!("the skill is larger than {} MB", MAX_SKILL_BYTES / MB)));
            }
            Ok(SkillFile { path, bytes: std::fs::read(file)? })
        })
        .collect()
}

/// Checks a skill's files before they are installed: safe paths, the size
/// limits, and a valid SKILL.md at the top. Returns the frontmatter and the
/// files with normalized paths.
pub fn check(files: Vec<SkillFile>) -> Result<(SkillMeta, Vec<SkillFile>)> {
    if files.len() > MAX_FILES {
        return Err(SkillError::TooLarge(format!("the skill has more than {MAX_FILES} files")));
    }
    let mut seen = BTreeSet::new();
    let mut total = 0;
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let mut path = safe_relative(&f.path).ok_or_else(|| SkillError::UnsafePath(f.path.clone()))?;
        if path.eq_ignore_ascii_case(SKILL_FILE) {
            path = SKILL_FILE.to_string();
        }
        // Folders on Windows ignore letter case.
        if !seen.insert(path.to_lowercase()) {
            return Err(SkillError::UnsafePath(path));
        }
        let size = f.bytes.len() as u64;
        if size > MAX_FILE_BYTES {
            return Err(SkillError::TooLarge(format!("{path} is larger than {} MB", MAX_FILE_BYTES / MB)));
        }
        total += size;
        out.push(SkillFile { path, bytes: f.bytes });
    }
    if total > MAX_SKILL_BYTES {
        return Err(SkillError::TooLarge(format!("the skill is larger than {} MB", MAX_SKILL_BYTES / MB)));
    }
    let skill = out.iter().find(|f| f.path == SKILL_FILE).ok_or(SkillError::NoSkillFile)?;
    let text = std::str::from_utf8(&skill.bytes).map_err(|_| SkillError::NotText(SKILL_FILE.into()))?;
    let (meta, _) = frontmatter::read(text)?;
    Ok((meta, out))
}

/// `path` as a normalized relative path inside a skill ("references/a.md"),
/// or `None` when it could leave the folder or is no valid Windows name.
pub fn safe_relative(path: &str) -> Option<String> {
    let path = path.trim().replace('\\', "/");
    // Absolute paths, drive letters and Windows' alternate data streams.
    if path.starts_with('/') || path.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p if p.ends_with(['.', ' '])
                || reserved_on_windows(p)
                || p.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) =>
            {
                return None;
            }
            p => parts.push(p),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The file `rel` inside `dir` if it exists there as a real file, also after
/// resolving links.
pub fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let path = dir.join(rel);
    if !std::fs::symlink_metadata(&path).ok()?.is_file() {
        return None;
    }
    let (root, real) = (dir.canonicalize().ok()?, path.canonicalize().ok()?);
    real.starts_with(root).then_some(path)
}

/// A text file of at most `max` bytes.
pub fn read_text(path: &Path, max: u64) -> Result<String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if std::fs::metadata(path)?.len() > max {
        return Err(SkillError::TooLarge(format!("{name} is larger than {} KB", max / 1024)));
    }
    let bytes = std::fs::read(path)?;
    if bytes.contains(&0) {
        return Err(SkillError::NotText(name));
    }
    String::from_utf8(bytes).map_err(|_| SkillError::NotText(name))
}

/// Files of a skill folder: relative paths with '/' and sizes, sorted.
pub fn files(dir: &Path) -> Vec<(String, u64)> {
    walk(dir, MAX_FILES).into_iter().map(|(rel, _, size)| (rel, size)).collect()
}

fn read_meta(dir: &Path) -> Result<SkillMeta> {
    let text = read_text(&dir.join(SKILL_FILE), frontmatter::MAX_SKILL_MD_BYTES as u64)?;
    Ok(frontmatter::read(&text)?.0)
}

/// Files below `dir` (relative path, full path, size), sorted, without links
/// and `.git`. Stops after `limit + 1`, so callers see that there are more.
fn walk(dir: &Path, limit: usize) -> Vec<(String, PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), String::new(), 0)];
    'walk: while let Some((folder, prefix, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if kind.is_dir() {
                if name != ".git" && depth < MAX_DEPTH {
                    stack.push((entry.path(), rel, depth + 1));
                }
            } else if kind.is_file() {
                out.push((rel, entry.path(), entry.metadata().map_or(0, |m| m.len())));
                if out.len() > limit {
                    break 'walk;
                }
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn unified_diff(before: &str, after: &str) -> String {
    let (before, after) = (before.replace("\r\n", "\n"), after.replace("\r\n", "\n"));
    similar::TextDiff::from_lines(&before, &after).unified_diff().context_radius(3).header("SKILL.md (installed)", "SKILL.md (new)").to_string()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_md(name: &str, body: &str) -> String {
        format!("---\nname: {name}\ndescription: Helps with {name}.\nmetadata:\n  version: \"1\"\n---\n\n{body}\n")
    }

    fn files(name: &str, extra: &[(&str, &str)]) -> Vec<SkillFile> {
        std::iter::once((SKILL_FILE.to_string(), skill_md(name, "# Steps")))
            .chain(extra.iter().map(|(p, t)| (p.to_string(), t.to_string())))
            .map(|(path, text)| SkillFile { path, bytes: text.into_bytes() })
            .collect()
    }

    fn folder() -> SkillSource {
        SkillSource::Folder { path: "D:/skills".into() }
    }

    #[test]
    fn install_enable_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let store = SkillStore::new(dir.path().join("skills"));
        let added = store.install(vec![(files("pdf", &[("references/forms.md", "# Forms")]), folder())]).unwrap();
        assert_eq!(added.len(), 1);
        let info = &added[0];
        assert_eq!((info.id.as_str(), info.name.as_str(), info.description.as_str()), ("pdf", "pdf", "Helps with pdf."));
        assert_eq!(info.version.as_deref(), Some("1"));
        assert!(!info.enabled && !info.reviewed, "new skills start switched off");
        assert_eq!(info.files, 2);
        assert!(dir.path().join("skills/pdf/references/forms.md").is_file());
        assert!(store.enabled(None).is_empty());

        store.set_enabled("pdf", true, None).unwrap();
        let on = store.enabled(None);
        assert_eq!(on.len(), 1);
        assert_eq!(on[0].description, "Helps with pdf.");
        store.set_enabled("pdf", false, None).unwrap();
        let listed = store.list(None);
        assert!(!listed[0].enabled && listed[0].reviewed, "the confirmation is remembered");

        let content = store.content("pdf", None).unwrap();
        assert!(content.text.starts_with("---\nname: pdf"));
        assert_eq!(content.files, vec!["SKILL.md", "references/forms.md"]);

        assert!(matches!(store.install(vec![(files("pdf", &[]), folder())]), Err(SkillError::Exists(n)) if n == "pdf"));
        store.remove("pdf").unwrap();
        assert!(store.list(None).is_empty());
        assert!(!dir.path().join("skills/pdf").exists());
        assert!(matches!(store.remove("pdf"), Err(SkillError::NotFound(_))));
        assert!(matches!(store.set_enabled("pdf", true, None), Err(SkillError::NotFound(_))));
    }

    #[test]
    fn a_batch_is_installed_whole_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let store = SkillStore::new(dir.path().to_path_buf());
        let broken = vec![SkillFile { path: SKILL_FILE.into(), bytes: b"no frontmatter".to_vec() }];
        assert!(store.install(vec![(files("a", &[]), folder()), (broken, folder())]).is_err());
        assert!(store.list(None).is_empty() && !dir.path().join("a").exists());
        assert!(matches!(store.install(vec![(files("a", &[]), folder()), (files("a", &[]), folder())]), Err(SkillError::Exists(_))));
        assert_eq!(store.install(vec![(files("a", &[]), folder()), (files("b", &[]), folder())]).unwrap().len(), 2);
    }

    #[test]
    fn files_are_checked_before_anything_is_written() {
        let unsafe_paths = ["../evil.md", "a/../../evil.md", "/etc/passwd", "C:/x.md", "C:\\x.md", "a:stream", "con/x.md", "nul", "x.md.", "a/b /c", "x<y", ""];
        for path in unsafe_paths {
            let mut f = files("a", &[]);
            f.push(SkillFile { path: path.into(), bytes: vec![] });
            assert!(matches!(check(f), Err(SkillError::UnsafePath(_))), "{path:?}");
        }
        let mut twice = files("a", &[("Notes.md", "x")]);
        twice.push(SkillFile { path: "notes.md".into(), bytes: vec![] });
        assert!(matches!(check(twice), Err(SkillError::UnsafePath(_))), "same name in another case");
        assert!(matches!(check(vec![SkillFile { path: "README.md".into(), bytes: vec![] }]), Err(SkillError::NoSkillFile)));
        let big = vec![SkillFile { path: "skill.md".into(), bytes: vec![b'x'; MAX_FILE_BYTES as usize + 1] }];
        assert!(matches!(check(big), Err(SkillError::TooLarge(_))));
        let many: Vec<SkillFile> = files("a", &[]).into_iter().chain((0..MAX_FILES).map(|i| SkillFile { path: format!("f{i}.md"), bytes: vec![] })).collect();
        assert!(matches!(check(many), Err(SkillError::TooLarge(_))));
        let binary = vec![SkillFile { path: SKILL_FILE.into(), bytes: vec![0xff, 0xfe] }];
        assert!(matches!(check(binary), Err(SkillError::NotText(_))));
        // A lower-case skill.md is accepted and stored as SKILL.md; "./" and "\" are normalized.
        let lower = vec![
            SkillFile { path: "skill.md".into(), bytes: skill_md("a", "x").into_bytes() },
            SkillFile { path: ".\\references\\a.md".into(), bytes: vec![] },
        ];
        let (meta, out) = check(lower).unwrap();
        assert_eq!(meta.name, "a");
        assert_eq!(out.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["SKILL.md", "references/a.md"]);
    }

    #[test]
    fn updates_show_their_changes_and_keep_the_switch() {
        let dir = tempfile::tempdir().unwrap();
        let store = SkillStore::new(dir.path().to_path_buf());
        store.install(vec![(files("rea", &[("references/a.md", "A"), ("references/old.md", "old")]), folder())]).unwrap();
        store.set_enabled("rea", true, None).unwrap();

        let same = store.compare("rea", files("rea", &[("references/a.md", "A"), ("references/old.md", "old")]), "").unwrap();
        assert!(same.up_to_date && same.diff.is_empty());

        let mut newer = files("rea", &[("references/a.md", "A2"), ("references/new.md", "new")]);
        newer[0].bytes = skill_md("rea", "# Steps\nOne more step.").into_bytes();
        let update = store.compare("rea", newer.clone(), "abc123").unwrap();
        assert!(!update.up_to_date);
        assert_eq!(update.commit, "abc123");
        assert_eq!(update.added, vec!["references/new.md"]);
        assert_eq!(update.removed, vec!["references/old.md"]);
        assert_eq!(update.changed, vec!["SKILL.md", "references/a.md"]);
        assert!(update.diff.contains("+One more step."), "{}", update.diff);

        let source = SkillSource::Github { repo: "o/r".into(), git_ref: None, path: ".agents/skills/rea".into(), commit: "abc123".into(), tree: "t".into() };
        let info = store.update("rea", newer, source.clone()).unwrap();
        assert!(info.enabled, "an update keeps the skill on");
        assert_eq!(info.source, source);
        assert!(!dir.path().join("rea/references/old.md").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("rea/references/new.md")).unwrap(), "new");

        assert!(matches!(store.update("rea", files("other", &[]), folder()), Err(SkillError::Renamed { .. })));
        assert!(matches!(store.compare("rea", files("other", &[]), ""), Err(SkillError::Renamed { .. })));
        assert!(matches!(store.update("missing", files("missing", &[]), folder()), Err(SkillError::NotFound(_))));
    }

    #[test]
    fn project_skills_are_read_in_place_and_switched_per_project() {
        let dir = tempfile::tempdir().unwrap();
        let store = SkillStore::new(dir.path().join("store"));
        let project = dir.path().join("shop");
        for (folder, text) in [("deploy", skill_md("deploy", "Run it.")), ("broken", "no frontmatter".into()), ("pdf", skill_md("pdf", "Project pdf."))] {
            let d = project.join(".agents/skills").join(folder);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(SKILL_FILE), text).unwrap();
        }
        store.install(vec![(files("pdf", &[]), folder())]).unwrap();
        let p = Project { root: &project, key: "abc" };
        let listed = store.list(Some(p));
        let ids: Vec<&str> = listed.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["pdf", "project:broken", "project:deploy", "project:pdf"]);
        let broken = &listed[1];
        assert!(broken.error.is_some() && broken.source == SkillSource::Project);
        assert!(matches!(store.set_enabled("project:broken", true, Some(p)), Err(SkillError::NotFound(_))));

        store.set_enabled("project:deploy", true, Some(p)).unwrap();
        store.set_enabled("project:pdf", true, Some(p)).unwrap();
        store.set_enabled("pdf", true, None).unwrap();
        let on = store.enabled(Some(p));
        assert_eq!(on.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["pdf", "deploy"]);
        assert_eq!(on[0].dir, dir.path().join("store/pdf"), "the installed skill wins over the project's of the same name");
        assert!(store.enabled(Some(Project { root: &project, key: "other" })).iter().all(|s| s.name != "deploy"), "per project");
        assert!(store.enabled(None).iter().all(|s| s.name != "deploy"));
        assert!(store.content("project:deploy", Some(p)).unwrap().text.contains("Run it."));
        assert!(project.join(".agents/skills/deploy/SKILL.md").is_file(), "never moved");
    }

    #[test]
    fn folders_with_one_or_many_skills() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        for name in ["a", "b"] {
            let d = repo.join(".agents/skills").join(name);
            std::fs::create_dir_all(d.join(".git")).unwrap();
            std::fs::write(d.join(SKILL_FILE), skill_md(name, "x")).unwrap();
            std::fs::write(d.join(".git/config"), "secret").unwrap();
        }
        let found = skill_folders(&repo);
        assert_eq!(found, vec![repo.join(".agents/skills/a"), repo.join(".agents/skills/b")]);
        assert_eq!(skill_folders(&found[0]), vec![found[0].clone()]);
        assert!(skill_folders(&dir.path().join("missing")).is_empty());
        let read = read_folder(&found[0]).unwrap();
        assert_eq!(read.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["SKILL.md"], ".git is left out");
    }

    #[test]
    fn a_broken_index_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(INDEX), "{ broken").unwrap();
        std::fs::create_dir_all(dir.path().join(".staging-x-1")).unwrap();
        let store = SkillStore::new(dir.path().to_path_buf());
        assert!(!dir.path().join(".staging-x-1").exists(), "leftovers of an interrupted install are removed");
        assert!(store.list(None).is_empty());
        assert!(dir.path().join("skills.json.broken").exists());
        store.install(vec![(files("a", &[]), folder())]).unwrap();
        assert_eq!(store.list(None).len(), 1);
    }

    #[test]
    fn safe_paths() {
        assert_eq!(safe_relative("references/a.md").as_deref(), Some("references/a.md"));
        assert_eq!(safe_relative("./a//b\\c.md").as_deref(), Some("a/b/c.md"));
        assert_eq!(safe_relative(".gitignore").as_deref(), Some(".gitignore"));
        for bad in ["", ".", "..", "../a", "/a", "\\\\server\\share", "a/../b", "D:a", "aux.txt", "a/prn", "a?"] {
            assert_eq!(safe_relative(bad), None, "{bad:?}");
        }
    }
}
