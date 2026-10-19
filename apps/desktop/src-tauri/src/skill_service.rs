//! Skills in the app: the installed ones, the open project's own, and
//! installing from GitHub or a folder. Every request to GitHub goes through
//! the network gate as a skill download (off until the user allows it) and
//! shows up in the network log. Files are fetched pinned to a commit.

use crate::error::{AppError, AppResult};
use crate::network::NetPurpose;
use crate::state::AppState;
use futures_util::future::{join_all, try_join_all};
use skills::frontmatter::{self, MAX_SKILL_MD_BYTES};
use skills::github::{self, Found, RemoteFile, RepoAddress, RepoListing, SkillCandidate};
use skills::store::{self, MAX_FILE_BYTES, SkillFile};
use skills::{EnabledSkill, Project, SkillInfo, SkillSource, SkillStore, SkillUpdate};
use std::collections::BTreeSet;
use std::path::Path;
use workspace::Workspace;

/// Upper bound for one answer of GitHub's API (the tree of a large repository).
const MAX_API_BYTES: u64 = 32 * 1024 * 1024;
/// Files fetched at the same time.
const PARALLEL: usize = 4;

/// The skill folders of a repository at a commit, from the last listing.
pub struct CachedTree {
    repo: String,
    commit: String,
    found: Vec<Found>,
}

/// Runs `f` with the open project as the skill store sees it.
fn with_project<T>(ws: Option<&Workspace>, f: impl FnOnce(Option<Project<'_>>) -> T) -> T {
    match ws {
        Some(ws) => {
            let key = crate::paths::project_key(ws.root());
            f(Some(Project { root: ws.root(), key: &key }))
        }
        None => f(None),
    }
}

/// The skills that are on, for the chat and the agents (any model).
pub fn enabled(store: &SkillStore, ws: Option<&Workspace>) -> Vec<EnabledSkill> {
    with_project(ws, |p| store.enabled(p))
}

pub fn list(store: &SkillStore, ws: Option<&Workspace>) -> Vec<SkillInfo> {
    with_project(ws, |p| store.list(p))
}

pub fn set_enabled(store: &SkillStore, ws: Option<&Workspace>, id: &str, on: bool) -> AppResult<()> {
    Ok(with_project(ws, |p| store.set_enabled(id, on, p))?)
}

pub fn content(store: &SkillStore, ws: Option<&Workspace>, id: &str) -> AppResult<skills::SkillContent> {
    Ok(with_project(ws, |p| store.content(id, p))?)
}

/// The recommended skills bundled with Ylide (REA is the first), each marked
/// whether it is installed already.
pub fn recommended(store: &SkillStore) -> Vec<skills::RecommendedInfo> {
    store.recommended()
}

/// SKILL.md and files of a recommended skill, from the bundle (no network),
/// for "View content" before it is installed.
pub fn recommended_content(store: &SkillStore, name: &str) -> AppResult<skills::SkillContent> {
    Ok(store.recommended_content(name)?)
}

/// Installs a recommended skill from the bundle and switches it on (the user
/// saw its content first).
pub fn install_recommended(store: &SkillStore, name: &str) -> AppResult<SkillInfo> {
    Ok(store.install_recommended(name)?)
}

/// Installs every skill in a folder on this computer (the folder itself, or
/// the skills in it, also below `.agents/skills`), switched off.
pub fn install_folder(store: &SkillStore, dir: &Path) -> AppResult<Vec<SkillInfo>> {
    let folders = store::skill_folders(dir);
    if folders.is_empty() {
        return Err(AppError::new("skill_none_found", dir.display()));
    }
    let batch = folders
        .iter()
        .map(|f| Ok((store::read_folder(f)?, SkillSource::Folder { path: f.display().to_string() })))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(store.install(batch)?)
}

/// Lists the skills of a repository (or of a folder in it) with their SKILL.md.
pub async fn browse(state: &AppState, input: &str) -> AppResult<RepoListing> {
    let address = github::parse_address(input)?;
    let commit = github::parse_commit(&fetch_json(state, &address.commit_url()).await?)?;
    let tree = github::parse_tree(&fetch_json(state, &address.tree_url(&commit)).await?)?;
    let found = github::find_skills(&tree, &address.path);
    if found.is_empty() {
        let why = if tree.truncated { "the repository is too large to list whole; paste the address of its skills folder" } else { "there is no SKILL.md in it" };
        return Err(AppError::new("skill_none_found", format!("{}: {why}", address.full_name())));
    }
    let installed = state.skills.installed_names();
    let mut candidates = Vec::with_capacity(found.len());
    for chunk in found.chunks(PARALLEL) {
        candidates.extend(join_all(chunk.iter().map(|f| candidate(state, &address, &commit, f, &installed))).await);
    }
    *state.skill_tree.lock().unwrap() = Some(CachedTree { repo: address.full_name(), commit: commit.clone(), found });
    Ok(RepoListing { repo: address.full_name(), git_ref: address.git_ref, commit, candidates })
}

async fn candidate(state: &AppState, address: &RepoAddress, commit: &str, found: &Found, installed: &BTreeSet<String>) -> SkillCandidate {
    let folder = found.path.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or(&address.repo);
    let mut c = SkillCandidate {
        path: found.path.clone(),
        name: folder.to_string(),
        description: String::new(),
        version: None,
        files: found.files.len() as u32,
        bytes: found.bytes(),
        installed: false,
        content: String::new(),
        error: found.too_large(),
    };
    let Some(file) = found.skill_file() else { return c };
    match fetch(state, &address.raw_url(commit, &file.path), MAX_SKILL_MD_BYTES as u64, false).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => {
                match frontmatter::read(&text) {
                    Ok((meta, _)) => {
                        c.name = meta.name;
                        c.description = meta.description;
                        c.version = meta.version;
                    }
                    Err(e) => c.error = c.error.take().or(Some(e.to_string())),
                }
                c.content = text;
            }
            Err(_) => c.error = Some("SKILL.md is not a text file".into()),
        },
        Err(e) => c.error = Some(e.message),
    }
    c.installed = installed.contains(&c.name);
    c
}

/// A commit id as GitHub gives it (40 hex digits); it becomes part of the addresses.
fn check_commit(commit: &str) -> AppResult<()> {
    if commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::new("skill_address", format!("'{commit}' is no commit id")))
    }
}

/// Installs the chosen skill folders of a listed repository, pinned to its commit.
pub async fn install_github(state: &AppState, repo: &str, git_ref: Option<String>, commit: &str, paths: &[String]) -> AppResult<Vec<SkillInfo>> {
    check_commit(commit)?;
    let address = RepoAddress::new(repo, git_ref.clone(), "")?;
    let mut batch = Vec::new();
    for path in paths {
        let found = found_at(state, &address, commit, path).await?;
        let files = download(state, &address, commit, &found).await?;
        let source = SkillSource::Github { repo: address.full_name(), git_ref: git_ref.clone(), path: found.path, commit: commit.to_string(), tree: found.tree };
        batch.push((files, source));
    }
    Ok(state.skills.install(batch)?)
}

/// Looks for a newer version: a GitHub skill whose folder changed on its
/// branch, or a folder skill whose folder changed on disk. Shows what would change.
pub async fn check_update(state: &AppState, name: &str) -> AppResult<SkillUpdate> {
    match state.skills.source(name)? {
        SkillSource::Github { repo, git_ref, path, tree, .. } => {
            let address = RepoAddress::new(&repo, git_ref, "")?;
            let commit = github::parse_commit(&fetch_json(state, &address.commit_url()).await?)?;
            let found = found_at(state, &address, &commit, &path).await?;
            if found.tree == tree {
                return Ok(SkillUpdate { name: name.to_string(), commit, up_to_date: true, version: None, added: vec![], removed: vec![], changed: vec![], diff: String::new() });
            }
            let files = download(state, &address, &commit, &found).await?;
            Ok(state.skills.compare(name, files, &commit)?)
        }
        SkillSource::Folder { path } => Ok(state.skills.compare(name, store::read_folder(Path::new(&path))?, "")?),
        // Recommended skills update to the version Ylide ships with (bundled, no network).
        SkillSource::Recommended { .. } => {
            let rec = skills::recommended::find(name).ok_or_else(|| AppError::new("skill_not_found", name))?;
            Ok(state.skills.compare(name, rec.files(), "")?)
        }
        SkillSource::Project => Err(AppError::new("skill_not_found", name)),
    }
}

/// Installs the version that `check_update` showed (`commit` for GitHub skills).
pub async fn update(state: &AppState, name: &str, commit: &str) -> AppResult<SkillInfo> {
    match state.skills.source(name)? {
        SkillSource::Github { repo, git_ref, path, .. } => {
            check_commit(commit)?;
            let address = RepoAddress::new(&repo, git_ref.clone(), "")?;
            let found = found_at(state, &address, commit, &path).await?;
            let files = download(state, &address, commit, &found).await?;
            let source = SkillSource::Github { repo: address.full_name(), git_ref, path, commit: commit.to_string(), tree: found.tree };
            Ok(state.skills.update(name, files, source)?)
        }
        SkillSource::Folder { path } => Ok(state.skills.update(name, store::read_folder(Path::new(&path))?, SkillSource::Folder { path })?),
        SkillSource::Recommended { .. } => {
            let rec = skills::recommended::find(name).ok_or_else(|| AppError::new("skill_not_found", name))?;
            Ok(state.skills.update(name, rec.files(), rec.source())?)
        }
        SkillSource::Project => Err(AppError::new("skill_not_found", name)),
    }
}

/// The skill folder `path` of the repository at `commit`, from the last
/// listing or from a new tree request.
async fn found_at(state: &AppState, address: &RepoAddress, commit: &str, path: &str) -> AppResult<Found> {
    let cached = state.skill_tree.lock().unwrap().as_ref().and_then(|c| {
        (c.repo == address.full_name() && c.commit == commit).then(|| c.found.iter().find(|f| f.path == path).cloned()).flatten()
    });
    let found = match cached {
        Some(f) => f,
        None => {
            let tree = github::parse_tree(&fetch_json(state, &address.tree_url(commit)).await?)?;
            let found = github::find_skills(&tree, path);
            let f = found.iter().find(|f| f.path == path).cloned();
            *state.skill_tree.lock().unwrap() = Some(CachedTree { repo: address.full_name(), commit: commit.to_string(), found });
            f.ok_or_else(|| AppError::new("skill_gone", format!("{} has no skill in {path} any more", address.full_name())))?
        }
    };
    match found.too_large() {
        Some(why) => Err(AppError::new("skill_too_large", why)),
        None => Ok(found),
    }
}

/// The files of a skill folder at `commit`, a few at a time.
async fn download(state: &AppState, address: &RepoAddress, commit: &str, found: &Found) -> AppResult<Vec<SkillFile>> {
    let mut files = Vec::with_capacity(found.files.len());
    for chunk in found.files.chunks(PARALLEL) {
        files.extend(try_join_all(chunk.iter().map(|f| download_file(state, address, commit, f))).await?);
    }
    Ok(files)
}

async fn download_file(state: &AppState, address: &RepoAddress, commit: &str, file: &RemoteFile) -> AppResult<SkillFile> {
    let bytes = fetch(state, &address.raw_url(commit, &file.path), MAX_FILE_BYTES, false).await?;
    Ok(SkillFile { path: file.rel.clone(), bytes })
}

async fn fetch_json(state: &AppState, url: &str) -> AppResult<serde_json::Value> {
    let body = fetch(state, url, MAX_API_BYTES, true).await?;
    serde_json::from_slice(&body).map_err(|e| AppError::new("network", format!("GitHub sent no valid answer: {e}")))
}

/// One request through the gate, at most `max` bytes.
async fn fetch(state: &AppState, url: &str, max: u64, api: bool) -> AppResult<Vec<u8>> {
    state.net.check(&state.settings().network, NetPurpose::SkillDownload)?;
    let mut request = state.net.client().get(url);
    if api {
        request = request.header(reqwest::header::ACCEPT, "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");
    }
    let mut response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            state.net.record(NetPurpose::SkillDownload, url, format!("failed: {e}"));
            return Err(e.into());
        }
    };
    let status = response.status();
    state.net.record(NetPurpose::SkillDownload, url, status.as_u16());
    if !status.is_success() {
        let used_up = response.headers().get("x-ratelimit-remaining").is_some_and(|v| v == "0");
        return Err(match status.as_u16() {
            403 | 429 if used_up => AppError::new("skill_rate_limited", "GitHub's limit for requests without an account is used up for this hour"),
            404 => AppError::new("skill_repo_not_found", url),
            _ => AppError::new("network", format!("HTTP {status}")),
        });
    }
    let too_large = || AppError::new("skill_too_large", format!("{url} is larger than {} KB", max / 1024));
    if response.content_length().is_some_and(|len| len > max) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() as u64 > max {
            return Err(too_large());
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::AppPaths;

    fn state(dir: &Path) -> AppState {
        let paths = AppPaths {
            config: dir.join("config"),
            cache: dir.join("cache"),
            data: dir.join("data"),
            default_models: dir.join("models"),
            runtimes: dir.join("runtimes"),
            checkpoints: dir.join("checkpoints"),
            skills: dir.join("skills"),
            run: dir.join("run"),
            logs: dir.join("logs"),
            bundled_runtimes: vec![],
        };
        AppState::new(paths)
    }

    #[tokio::test]
    async fn github_stays_closed_until_skill_downloads_are_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let err = browse(&state, "https://github.com/morluto/rea").await.unwrap_err();
        assert_eq!(err.code, "network_disabled");
        assert!(state.net.entries().is_empty(), "nothing was sent");
        assert_eq!(browse(&state, "https://gitlab.com/o/r").await.unwrap_err().code, "skill_address");
        let bad = install_github(&state, "morluto/rea", None, "../../x", &[".agents/skills/x".into()]).await.unwrap_err();
        assert_eq!(bad.code, "skill_address", "commit ids become part of addresses");
    }

    #[tokio::test]
    async fn recommended_skill_installs_from_the_bundle_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        // No network permission is needed: the files are bundled.
        let listed = recommended(&state.skills);
        let rea = listed.iter().find(|r| r.name == "reverse-engineer-anything").expect("REA is recommended");
        assert!(!rea.installed && rea.needs_mcp && rea.license == "MIT");
        assert!(recommended_content(&state.skills, "reverse-engineer-anything").unwrap().text.contains("reverse-engineer-anything"));

        let info = install_recommended(&state.skills, "reverse-engineer-anything").unwrap();
        assert!(info.enabled && info.license.as_deref() == Some("MIT"));
        assert!(enabled(&state.skills, None).iter().any(|s| s.name == "reverse-engineer-anything"));
        // It is the version Ylide ships with, so there is no update to install.
        let update = check_update(&state, "reverse-engineer-anything").await.unwrap();
        assert!(update.up_to_date, "{update:?}");
        assert!(state.net.entries().is_empty(), "nothing was sent over the network");
    }

    /// The whole way against GitHub: list a real repository, install its
    /// skills, read one as the agents do, look for updates.
    ///
    /// ```text
    /// cargo test -p ylide-desktop --lib skill_service -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "talks to GitHub"]
    async fn installs_the_skills_of_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        state.settings.write().unwrap().network.allow_skill_downloads = true;

        let listing = browse(&state, "https://github.com/morluto/rea").await.unwrap();
        println!("{} at {}", listing.repo, listing.commit);
        for c in &listing.candidates {
            println!("  {} ({} files, {} bytes) {:?}", c.name, c.files, c.bytes, c.error);
        }
        let rea = listing.candidates.iter().find(|c| c.name == "reverse-engineer-anything").expect("REA's main skill");
        assert!(rea.error.is_none() && rea.content.contains("name: reverse-engineer-anything"));
        let paths: Vec<String> = listing.candidates.iter().filter(|c| c.error.is_none()).map(|c| c.path.clone()).collect();
        let installed = install_github(&state, &listing.repo, None, &listing.commit, &paths).await.unwrap();
        assert_eq!(installed.len(), paths.len());
        assert!(installed.iter().all(|s| !s.enabled && s.error.is_none()));

        set_enabled(&state.skills, None, "reverse-engineer-anything", true).unwrap();
        let enabled = enabled(&state.skills, None);
        let text = skills::prompt::read(&enabled, "reverse-engineer-anything", None, 1, skills::prompt::read_budget(16_384)).unwrap();
        println!("{}", &text[..text.len().min(600)]);
        assert!(text.starts_with("Skill reverse-engineer-anything, SKILL.md (lines 1-"), "{text}");
        assert!(text.contains("more lines; call skill_read"), "the long SKILL.md comes in parts");
        let reference = skills::prompt::read(&enabled, "reverse-engineer-anything", Some("references/connection-and-recovery.md"), 1, 12_000).unwrap();
        assert!(reference.starts_with("Skill reverse-engineer-anything, references/connection-and-recovery.md"), "{reference}");

        let update = check_update(&state, "reverse-engineer-anything").await.unwrap();
        assert!(update.up_to_date, "{update:?}");
        let log = state.net.entries();
        assert!(log.iter().all(|e| e.purpose == NetPurpose::SkillDownload), "every request is a skill download");
        println!("{} requests, all logged", log.len());
    }
}
