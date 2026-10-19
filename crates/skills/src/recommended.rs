//! Recommended skills that ship with Ylide: a small, curated catalogue the
//! Skills page offers with one click. Their files are bundled in the binary
//! (no network), so the user can read them before switching one on. Nothing is
//! installed or loaded into a prompt until the user adds it; recommended skills
//! are off by default, like every other skill.
//!
//! The first one is REA (`reverse-engineer-anything`, from morluto/rea, MIT),
//! pinned to a commit. REA only does something once its own MCP server and
//! analysis engines are connected (see the MCP settings page); installing the
//! skill supplies the instructions, not the tools.

use crate::frontmatter::{self, SkillMeta};
use crate::store::{SkillContent, SkillFile, SkillSource};
use crate::{Result, SkillError};
use include_dir::{Dir, include_dir};
use serde::Serialize;
use ts_rs::TS;

/// REA's skill folder (SKILL.md + references/), vendored under
/// `recommended/reverse-engineer-anything/` and pinned to `REA_COMMIT`.
static REA_FILES: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/recommended/reverse-engineer-anything");

/// The commit of morluto/rea the bundled REA files were taken from.
const REA_COMMIT: &str = "f4322b15ed1423d736bd2572cf7a8eadf2b466e1";

/// A starting point for the MCP server a recommended skill needs. The user
/// reviews and edits it before it is added (the MCP settings page); Ylide
/// never installs the server's own programs (for REA: Ghidra, IDA, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerSuggestion {
    /// Suggested server id/name.
    pub id: &'static str,
    /// A local program that speaks MCP over stdio.
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// A short, factual note shown with the suggestion.
    pub note: &'static str,
}

/// A skill bundled with Ylide, with where it came from and the server it needs.
pub struct Recommended {
    /// The skill's name (also its id once installed).
    pub name: &'static str,
    /// "owner/repo" the skill was taken from.
    pub repo: &'static str,
    /// The commit the bundled files were taken from.
    pub commit: &'static str,
    /// The skill's licence (SPDX), from the source repository.
    pub license: &'static str,
    /// Where the skill's own tools are documented / installed.
    pub docs_url: &'static str,
    /// The MCP server the skill needs to use its tools, if any.
    pub mcp: Option<McpServerSuggestion>,
    files: &'static Dir<'static>,
}

/// The recommended skills, in display order.
pub fn catalog() -> &'static [Recommended] {
    static CATALOG: &[Recommended] = &[Recommended {
        name: "reverse-engineer-anything",
        repo: "morluto/rea",
        commit: REA_COMMIT,
        license: "MIT",
        docs_url: "https://rea.tools",
        mcp: Some(McpServerSuggestion {
            id: "rea",
            command: "npx",
            args: &["-y", "rea-agents@latest", "mcp"],
            note: "REA's server (the npm package rea-agents). Check the exact command for your setup at rea.tools; its analysis engines (Ghidra, IDA, …) are installed separately.",
        }),
        files: &REA_FILES,
    }];
    CATALOG
}

/// The recommended skill with this name.
pub fn find(name: &str) -> Option<&'static Recommended> {
    catalog().iter().find(|r| r.name == name)
}

impl Recommended {
    /// The bundled files, relative paths with '/', as the store installs them.
    pub fn files(&self) -> Vec<SkillFile> {
        let mut out = Vec::new();
        collect(self.files, &mut out);
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// The full SKILL.md text.
    pub fn skill_md(&self) -> Result<String> {
        let file = self.files.get_file("SKILL.md").ok_or(SkillError::NoSkillFile)?;
        std::str::from_utf8(file.contents()).map(str::to_string).map_err(|_| SkillError::NotText("SKILL.md".into()))
    }

    /// The checked frontmatter of the bundled SKILL.md.
    pub fn meta(&self) -> Result<SkillMeta> {
        Ok(frontmatter::read(&self.skill_md()?)?.0)
    }

    /// Where an installed copy records it came from.
    pub fn source(&self) -> SkillSource {
        SkillSource::Recommended {
            repo: self.repo.to_string(),
            commit: self.commit.to_string(),
            license: self.license.to_string(),
            url: self.github_url(),
        }
    }

    /// The skill's folder on GitHub at the pinned commit.
    pub fn github_url(&self) -> String {
        format!("https://github.com/{}/tree/{}/.agents/skills/{}", self.repo, self.commit, self.name)
    }

    /// SKILL.md in full and the list of files, for "View content" before installing.
    pub fn content(&self) -> Result<SkillContent> {
        Ok(SkillContent { text: self.skill_md()?, files: self.files().into_iter().map(|f| f.path).collect() })
    }

    /// The catalogue entry as the Skills page shows it; `installed` says whether
    /// a skill of this name is already installed (then it is not offered again).
    pub fn info(&self, installed: bool) -> RecommendedInfo {
        let files = self.files();
        let bytes = files.iter().map(|f| f.bytes.len() as u64).sum();
        let (description, version, error) = match self.meta() {
            Ok(m) => (m.description, m.version, None),
            Err(e) => (String::new(), None, Some(e.to_string())),
        };
        RecommendedInfo {
            id: self.name.to_string(),
            name: self.name.to_string(),
            description,
            version,
            repo: self.repo.to_string(),
            commit: self.commit.to_string(),
            license: self.license.to_string(),
            url: self.github_url(),
            docs_url: self.docs_url.to_string(),
            needs_mcp: self.mcp.is_some(),
            mcp_note: self.mcp.as_ref().map(|m| m.note.to_string()),
            files: files.len() as u32,
            bytes,
            installed,
            error,
        }
    }
}

/// A recommended skill as the Skills page lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecommendedInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    /// "owner/repo" the skill came from.
    pub repo: String,
    pub commit: String,
    pub license: String,
    /// The skill's folder on GitHub at the pinned commit.
    pub url: String,
    /// Where the skill's own tools are documented.
    pub docs_url: String,
    /// The skill needs an MCP server to use its tools.
    pub needs_mcp: bool,
    /// A short, factual note about that server.
    pub mcp_note: Option<String>,
    pub files: u32,
    #[ts(type = "number")]
    pub bytes: u64,
    /// A skill with this name is installed already.
    pub installed: bool,
    /// Why the bundled skill cannot be read (should never happen).
    pub error: Option<String>,
}

/// Collects every file of an embedded directory, with '/'-separated paths.
fn collect(dir: &Dir<'static>, out: &mut Vec<SkillFile>) {
    for file in dir.files() {
        out.push(SkillFile { path: file.path().to_string_lossy().replace('\\', "/"), bytes: file.contents().to_vec() });
    }
    for sub in dir.dirs() {
        collect(sub, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SKILL_FILE;

    #[test]
    fn rea_is_bundled_and_parses() {
        let rea = find("reverse-engineer-anything").expect("REA is in the catalogue");
        assert_eq!((rea.repo, rea.license), ("morluto/rea", "MIT"));
        assert_eq!(rea.commit.len(), 40, "pinned to a full commit id");
        let meta = rea.meta().unwrap();
        assert_eq!(meta.name, "reverse-engineer-anything");
        assert!(meta.description.contains("Reverse engineer"));

        let files = rea.files();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&SKILL_FILE), "has a SKILL.md: {paths:?}");
        assert!(paths.iter().any(|f| f.starts_with("references/")), "has reference files: {paths:?}");
        assert!(paths.iter().all(|f| !f.contains('\\')), "paths use '/': {paths:?}");
    }

    #[test]
    fn rea_needs_its_mcp_server() {
        let rea = find("reverse-engineer-anything").unwrap();
        let mcp = rea.mcp.as_ref().expect("REA declares an MCP server");
        assert_eq!(mcp.command, "npx");
        assert!(mcp.args.contains(&"rea-agents@latest"));

        let info = rea.info(false);
        assert!(info.needs_mcp && info.mcp_note.is_some() && !info.installed);
        assert!(info.bytes > 20_000 && info.files >= 2);
        assert!(info.url.contains("morluto/rea") && info.url.contains(rea.commit));
    }

    #[test]
    fn source_records_the_origin() {
        let rea = find("reverse-engineer-anything").unwrap();
        match rea.source() {
            SkillSource::Recommended { repo, commit, license, url } => {
                assert_eq!((repo.as_str(), license.as_str()), ("morluto/rea", "MIT"));
                assert_eq!(commit, REA_COMMIT);
                assert!(url.contains("morluto/rea"));
            }
            other => panic!("unexpected source {other:?}"),
        }
    }
}
