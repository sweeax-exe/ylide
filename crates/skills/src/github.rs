//! Installing skills from a GitHub repository: the address the user pastes,
//! the repository's git tree (one request lists every SKILL.md), and the
//! file addresses pinned to a commit. Only addresses and parsing live here;
//! the app sends the requests through its network gate, so each one shows up
//! in the network log.

use crate::store::{MAX_FILE_BYTES, MAX_FILES, MAX_SKILL_BYTES, SKILL_FILE, safe_relative};
use crate::{Result, SkillError};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

pub const API: &str = "https://api.github.com";
pub const RAW: &str = "https://raw.githubusercontent.com";
/// Skills offered from one repository at most.
pub const MAX_CANDIDATES: usize = 50;

/// A repository, optionally with a branch or tag and a folder in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoAddress {
    pub owner: String,
    pub repo: String,
    pub git_ref: Option<String>,
    /// Folder to look in ("" = the whole repository).
    pub path: String,
}

impl RepoAddress {
    pub fn new(full_name: &str, git_ref: Option<String>, path: &str) -> Result<Self> {
        let mut address = parse_address(full_name)?;
        address.git_ref = git_ref;
        address.path = path.to_string();
        Ok(address)
    }

    /// "owner/name".
    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The commit the branch or tag (or the default branch) points at.
    pub fn commit_url(&self) -> String {
        format!("{API}/repos/{}/{}/commits/{}", self.owner, self.repo, encode(self.git_ref.as_deref().unwrap_or("HEAD")))
    }

    /// Every file and folder of the commit, in one answer.
    pub fn tree_url(&self, commit: &str) -> String {
        format!("{API}/repos/{}/{}/git/trees/{commit}?recursive=1", self.owner, self.repo)
    }

    /// One file at the commit (not counted against GitHub's API limit).
    pub fn raw_url(&self, commit: &str, path: &str) -> String {
        format!("{RAW}/{}/{}/{commit}/{}", self.owner, self.repo, encode(path))
    }
}

/// Reads what the user pasted: `https://github.com/owner/repo`, with
/// `/tree/<ref>/<folder>` or `/blob/<ref>/<folder>/SKILL.md`, without the
/// scheme, or just `owner/repo`.
pub fn parse_address(input: &str) -> Result<RepoAddress> {
    let bad = |why: &str| SkillError::Address(format!("'{}' {why}", input.trim()));
    let text = input.trim().split(['?', '#']).next().unwrap_or_default();
    let text = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://")).unwrap_or(text);
    let text = text.strip_prefix("www.").unwrap_or(text);
    let rest = match text.split_once('/') {
        Some((host, rest)) if host.eq_ignore_ascii_case("github.com") => rest,
        Some((host, _)) if host.contains('.') || host.contains(':') => return Err(bad("is not a GitHub address")),
        _ => text,
    };
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    let (Some(owner), Some(repo)) = (parts.first(), parts.get(1)) else {
        return Err(bad("names no repository; use https://github.com/owner/repo"));
    };
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    let owner_ok = owner.len() <= 39 && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let repo_ok = repo.len() <= 100 && !matches!(repo, "." | "..") && repo.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !owner_ok || !repo_ok {
        return Err(bad("names no repository; use https://github.com/owner/repo"));
    }
    let (git_ref, path) = match parts.get(2).copied() {
        None => (None, String::new()),
        Some(kind @ ("tree" | "blob")) => {
            let git_ref = parts.get(3).ok_or_else(|| bad("names no branch"))?.to_string();
            let mut folder: Vec<&str> = parts[4..].to_vec();
            if kind == "blob" {
                // A link to a file: its folder (usually the SKILL.md of one skill).
                folder.pop();
            }
            let folder = folder.join("/");
            let path = if folder.is_empty() { String::new() } else { safe_relative(&folder).ok_or_else(|| bad("has an invalid folder"))? };
            (Some(git_ref), path)
        }
        Some(_) => return Err(bad("is no repository or folder address")),
    };
    Ok(RepoAddress { owner: owner.to_string(), repo: repo.to_string(), git_ref, path })
}

/// The commit id in an answer of the commits API.
pub fn parse_commit(json: &Value) -> Result<String> {
    json["sha"]
        .as_str()
        .filter(|s| s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_string)
        .ok_or_else(|| SkillError::Address("GitHub sent no commit".into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Folder,
    /// Links and submodules, which skills never get.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub path: String,
    pub kind: EntryKind,
    pub sha: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    /// Id of the root folder.
    pub sha: String,
    pub entries: Vec<TreeEntry>,
    /// GitHub lists at most 100,000 entries; the rest is missing then.
    pub truncated: bool,
}

/// An answer of the git trees API (`?recursive=1`).
pub fn parse_tree(json: &Value) -> Result<Tree> {
    let entries = json["tree"].as_array().ok_or_else(|| SkillError::Address("GitHub sent no file list".into()))?;
    Ok(Tree {
        sha: json["sha"].as_str().unwrap_or_default().to_string(),
        truncated: json["truncated"].as_bool().unwrap_or(false),
        entries: entries
            .iter()
            .filter_map(|e| {
                let kind = match (e["type"].as_str()?, e["mode"].as_str().unwrap_or_default()) {
                    ("blob", "120000") => EntryKind::Other,
                    ("blob", _) => EntryKind::File,
                    ("tree", _) => EntryKind::Folder,
                    _ => EntryKind::Other,
                };
                Some(TreeEntry { path: e["path"].as_str()?.to_string(), kind, sha: e["sha"].as_str().unwrap_or_default().to_string(), size: e["size"].as_u64().unwrap_or(0) })
            })
            .collect(),
    })
}

/// A file of a skill in the repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    /// Path in the repository.
    pub path: String,
    /// Path in the skill folder.
    pub rel: String,
    pub size: u64,
}

/// A folder with a SKILL.md in the repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The folder ("" = the repository root).
    pub path: String,
    /// Its git tree id, which changes whenever anything in it changes.
    pub tree: String,
    pub files: Vec<RemoteFile>,
}

impl Found {
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    /// Path of the SKILL.md in the repository.
    pub fn skill_file(&self) -> Option<&RemoteFile> {
        self.files.iter().find(|f| f.rel.eq_ignore_ascii_case(SKILL_FILE))
    }

    /// Why the skill cannot be installed, judged by the sizes in the tree.
    pub fn too_large(&self) -> Option<String> {
        const MB: u64 = 1024 * 1024;
        if self.files.len() > MAX_FILES {
            return Some(format!("the skill has more than {MAX_FILES} files"));
        }
        if let Some(f) = self.files.iter().find(|f| f.size > MAX_FILE_BYTES) {
            return Some(format!("{} is larger than {} MB", f.rel, MAX_FILE_BYTES / MB));
        }
        (self.bytes() > MAX_SKILL_BYTES).then(|| format!("the skill is larger than {} MB", MAX_SKILL_BYTES / MB))
    }
}

/// The skill folders below `under` (every SKILL.md's folder), each with its
/// files; files of a skill nested in another belong to the inner one only.
pub fn find_skills(tree: &Tree, under: &str) -> Vec<Found> {
    let in_folder = |path: &str, folder: &str| folder.is_empty() || path == folder || path.starts_with(&format!("{folder}/"));
    let mut folders: Vec<String> = tree
        .entries
        .iter()
        .filter(|e| e.kind == EntryKind::File)
        .filter_map(|e| {
            let (folder, name) = e.path.rsplit_once('/').unwrap_or(("", &e.path));
            name.eq_ignore_ascii_case(SKILL_FILE).then(|| folder.to_string())
        })
        .filter(|folder| in_folder(folder, under))
        .collect();
    folders.sort();
    folders.dedup();
    folders.truncate(MAX_CANDIDATES);
    folders
        .iter()
        .map(|folder| {
            let nested: Vec<&String> = folders.iter().filter(|other| *other != folder && in_folder(other, folder)).collect();
            let files = tree
                .entries
                .iter()
                .filter(|e| e.kind == EntryKind::File && in_folder(&e.path, folder) && !nested.iter().any(|n| in_folder(&e.path, n)))
                .map(|e| RemoteFile {
                    path: e.path.clone(),
                    rel: if folder.is_empty() { e.path.clone() } else { e.path[folder.len() + 1..].to_string() },
                    size: e.size,
                })
                .collect();
            let sha = if folder.is_empty() {
                tree.sha.clone()
            } else {
                tree.entries.iter().find(|e| e.kind == EntryKind::Folder && e.path == *folder).map(|e| e.sha.clone()).unwrap_or_default()
            };
            Found { path: folder.clone(), tree: sha, files }
        })
        .collect()
}

/// A skill offered for installing, as the add dialog shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillCandidate {
    /// Folder in the repository ("" = its root).
    pub path: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub files: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    /// A skill with this name is installed already.
    pub installed: bool,
    /// SKILL.md in full, to read before installing.
    pub content: String,
    /// Why it cannot be installed.
    pub error: Option<String>,
}

/// What a repository offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RepoListing {
    /// "owner/name".
    pub repo: String,
    pub git_ref: Option<String>,
    pub commit: String,
    pub candidates: Vec<SkillCandidate>,
}

/// Percent-encodes each segment of a path, keeping the slashes.
fn encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn addresses_people_paste() {
        let plain = parse_address("https://github.com/morluto/rea").unwrap();
        assert_eq!(plain, RepoAddress { owner: "morluto".into(), repo: "rea".into(), git_ref: None, path: String::new() });
        for same in ["github.com/morluto/rea", "morluto/rea", " https://www.github.com/morluto/rea.git/ ", "http://github.com/morluto/rea?tab=readme#top"] {
            assert_eq!(parse_address(same).unwrap(), plain, "{same}");
        }
        let folder = parse_address("https://github.com/morluto/rea/tree/main/.agents/skills").unwrap();
        assert_eq!((folder.git_ref.as_deref(), folder.path.as_str()), (Some("main"), ".agents/skills"));
        let file = parse_address("https://github.com/morluto/rea/blob/v1.2/.agents/skills/rea-tool-design/SKILL.md").unwrap();
        assert_eq!((file.git_ref.as_deref(), file.path.as_str()), (Some("v1.2"), ".agents/skills/rea-tool-design"));
        assert_eq!(parse_address("https://github.com/o/r/tree/dev").unwrap().path, "");
        for bad in ["", "rea", "https://gitlab.com/o/r", "https://github.com/o", "https://github.com/o/r/issues/3", "https://github.com/o/r/tree", "https://github.com/o/r/tree/main/../x", "o!/r", "o/r r"] {
            assert!(matches!(parse_address(bad), Err(SkillError::Address(_))), "{bad:?}");
        }
    }

    #[test]
    fn urls_are_pinned_and_encoded() {
        let a = RepoAddress::new("morluto/rea", Some("feature/x y".into()), "").unwrap();
        assert_eq!(a.full_name(), "morluto/rea");
        assert_eq!(a.commit_url(), "https://api.github.com/repos/morluto/rea/commits/feature/x%20y");
        let head = RepoAddress::new("o/r", None, "").unwrap();
        assert_eq!(head.commit_url(), "https://api.github.com/repos/o/r/commits/HEAD");
        assert_eq!(a.tree_url("abc"), "https://api.github.com/repos/morluto/rea/git/trees/abc?recursive=1");
        assert_eq!(a.raw_url("abc", ".agents/skills/x/a b#.md"), "https://raw.githubusercontent.com/morluto/rea/abc/.agents/skills/x/a%20b%23.md");
        let sha = "9744d07211ac750ae0273c4f91175eac0c890d9d";
        assert_eq!(parse_commit(&json!({ "sha": sha })).unwrap(), sha);
        assert!(parse_commit(&json!({ "message": "Not Found" })).is_err());
    }

    fn tree() -> Tree {
        let file = |path: &str, size: u64| json!({ "path": path, "type": "blob", "mode": "100644", "sha": format!("b-{path}"), "size": size });
        let folder = |path: &str| json!({ "path": path, "type": "tree", "mode": "040000", "sha": format!("t-{path}") });
        parse_tree(&json!({
            "sha": "root",
            "truncated": false,
            "tree": [
                file("README.md", 10),
                folder(".agents"), folder(".agents/skills"),
                folder(".agents/skills/rea"), file(".agents/skills/rea/SKILL.md", 23_510),
                folder(".agents/skills/rea/references"), file(".agents/skills/rea/references/a.md", 100),
                { "path": ".agents/skills/rea/link", "type": "blob", "mode": "120000", "sha": "l", "size": 5 },
                folder(".agents/skills/rea/nested"), file(".agents/skills/rea/nested/skill.md", 50), file(".agents/skills/rea/nested/x.md", 1),
                folder(".agents/skills/tool"), file(".agents/skills/tool/SKILL.md", 956),
                folder("docs"), file("docs/guide.md", 5),
                { "path": "vendor/lib", "type": "commit", "mode": "160000", "sha": "c" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn every_skill_folder_is_found_with_its_own_files() {
        let t = tree();
        assert_eq!(t.sha, "root");
        let found = find_skills(&t, "");
        let paths: Vec<&str> = found.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".agents/skills/rea", ".agents/skills/rea/nested", ".agents/skills/tool"]);
        let rea = &found[0];
        assert_eq!(rea.tree, "t-.agents/skills/rea");
        let rels: Vec<&str> = rea.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["SKILL.md", "references/a.md"], "links and the nested skill are left out");
        assert_eq!(rea.bytes(), 23_610);
        assert_eq!(rea.skill_file().unwrap().path, ".agents/skills/rea/SKILL.md");
        assert_eq!(found[1].skill_file().unwrap().rel, "skill.md");
        assert!(rea.too_large().is_none());

        assert_eq!(find_skills(&t, ".agents/skills/tool").len(), 1);
        assert_eq!(find_skills(&t, ".agents/skills/to").len(), 0, "folders match whole names");
        assert!(find_skills(&t, "docs").is_empty());
    }

    #[test]
    fn a_skill_in_the_repository_root_and_the_size_limits() {
        let t = parse_tree(&json!({ "sha": "root", "tree": [
            { "path": "SKILL.md", "type": "blob", "mode": "100644", "sha": "s", "size": 10 },
            { "path": "big.bin", "type": "blob", "mode": "100644", "sha": "b", "size": MAX_FILE_BYTES + 1 }
        ]}))
        .unwrap();
        let found = find_skills(&t, "");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].path.as_str(), found[0].tree.as_str()), ("", "root"));
        assert_eq!(found[0].files[1].rel, "big.bin");
        assert!(found[0].too_large().unwrap().contains("big.bin is larger than 2 MB"));
        assert!(parse_tree(&json!({ "message": "Not Found" })).is_err());
    }
}
