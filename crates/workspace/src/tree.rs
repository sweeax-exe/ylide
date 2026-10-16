//! Lazy file tree that respects `.gitignore`, `.ignore` and global git excludes.

use crate::{Result, Workspace, WorkspaceError};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum FileKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileNode {
    pub name: String,
    /// Project-relative, forward slashes.
    pub path: String,
    pub kind: FileKind,
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
}

/// Directories hidden even when not ignored (VCS internals and tool caches).
const ALWAYS_HIDDEN: &[&str] = &[".git", ".hg", ".svn"];

impl Workspace {
    pub(crate) fn walker(&self, start: &std::path::Path) -> WalkBuilder {
        let mut b = WalkBuilder::new(start);
        b.hidden(false) // show dotfiles like .github, .env.example
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .require_git(false)
            .parents(true)
            .filter_entry(|e| !ALWAYS_HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()));
        b
    }

    /// Direct children of `rel` (`""` = project root): folders first, then files.
    pub fn list_dir(&self, rel: &str) -> Result<Vec<FileNode>> {
        let dir = self.resolve(rel)?;
        if !dir.is_dir() {
            return Err(WorkspaceError::NotFound(rel.to_string()));
        }
        let mut nodes = Vec::new();
        for entry in self.walker(&dir).max_depth(Some(1)).build().flatten() {
            if entry.depth() == 0 {
                continue;
            }
            let Some(path) = self.relative(entry.path()) else { continue };
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            nodes.push(FileNode {
                name: entry.file_name().to_string_lossy().into_owned(),
                path,
                kind: if is_dir { FileKind::Dir } else { FileKind::File },
                size_bytes: if is_dir { None } else { entry.metadata().ok().map(|m| m.len()) },
            });
        }
        nodes.sort_by(|a, b| {
            (a.kind != FileKind::Dir, a.name.to_lowercase()).cmp(&(b.kind != FileKind::Dir, b.name.to_lowercase()))
        });
        Ok(nodes)
    }

    /// All non-ignored files below `rel`, up to `limit` entries (relative paths).
    pub fn list_files(&self, rel: &str, limit: usize) -> Result<Vec<String>> {
        let dir = self.resolve(rel)?;
        let mut out = Vec::new();
        for entry in self.walker(&dir).build().flatten() {
            if entry.file_type().is_some_and(|t| t.is_file())
                && let Some(p) = self.relative(entry.path())
            {
                out.push(p);
                if out.len() >= limit {
                    break;
                }
            }
        }
        out.sort();
        Ok(out)
    }

    /// Indented text outline of a folder for prompts (`depth` levels, `limit` entries).
    pub fn outline(&self, rel: &str, depth: usize, limit: usize) -> Result<String> {
        let dir = self.resolve(rel)?;
        let mut lines = Vec::new();
        let mut walker = self.walker(&dir);
        walker.max_depth(Some(depth)).sort_by_file_name(|a, b| a.cmp(b));
        let mut truncated = false;
        for entry in walker.build().flatten() {
            if entry.depth() == 0 {
                continue;
            }
            if lines.len() >= limit {
                truncated = true;
                break;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            let name = entry.file_name().to_string_lossy();
            lines.push(format!("{}{}{}", "  ".repeat(entry.depth() - 1), name, if is_dir { "/" } else { "" }));
        }
        if truncated {
            lines.push("  …".into());
        }
        Ok(lines.join("\n"))
    }

    /// Fuzzy file finder (Ctrl+P, @-mentions): subsequence match, best first.
    pub fn find_files(&self, query: &str, limit: usize) -> Vec<String> {
        let files = self.list_files("", 100_000).unwrap_or_default();
        // Candidates use forward slashes; Windows-style queries ("src\store.rs") match them too.
        let q: Vec<char> = query.to_lowercase().replace('\\', "/").chars().filter(|c| !c.is_whitespace()).collect();
        if q.is_empty() {
            return files.into_iter().take(limit).collect();
        }
        let mut scored: Vec<(i64, String)> = files.into_iter().filter_map(|f| fuzzy_score(&q, &f).map(|s| (s, f))).collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(&b.1)));
        scored.into_iter().take(limit).map(|(_, f)| f).collect()
    }
}

/// Scores `candidate` for the lower-cased query characters `q`; `None` if not a subsequence.
/// Rewards matches in the file name, consecutive runs and word starts.
pub fn fuzzy_score(q: &[char], candidate: &str) -> Option<i64> {
    let lower: Vec<char> = candidate.to_lowercase().chars().collect();
    // Indices are taken from `lower`: lower-casing can change the char count ('İ' becomes two chars).
    let name_start = lower.iter().rposition(|&c| c == '/').map_or(0, |i| i + 1);
    // Matching greedily from the start can spend query characters on early
    // folders (the "c" of "src/" for "cart"), so the match is also anchored at
    // every path segment that starts with the first query character and the
    // best alignment wins. Every candidate gets the same family of alignments,
    // which keeps scores comparable between candidates.
    let mut best = match_from(q, &lower, 0, name_start)?;
    let anchors = (1..lower.len()).filter(|&i| lower[i - 1] == '/' && q.first() == Some(&lower[i]));
    for start in anchors {
        match match_from(q, &lower, start, name_start) {
            Some(score) => best = best.max(score),
            // Later anchors only see a suffix of this one, so they cannot match either.
            None => break,
        }
    }
    Some(best - (lower.len() as i64 / 10))
}

/// Greedy subsequence match of `q` in `lower[start..]`.
fn match_from(q: &[char], lower: &[char], start: usize, name_start: usize) -> Option<i64> {
    let mut score = 0i64;
    let mut qi = 0;
    let mut last: Option<usize> = None;
    for (i, c) in lower.iter().enumerate().skip(start) {
        if qi == q.len() {
            break;
        }
        if *c == q[qi] {
            score += 1;
            if i >= name_start {
                score += 3;
            }
            if last == Some(i.wrapping_sub(1)) {
                score += 5;
            }
            if i == 0 || matches!(lower[i - 1], '/' | '_' | '-' | '.' | ' ') {
                score += 4;
            }
            last = Some(i);
            qi += 1;
        }
    }
    (qi == q.len()).then_some(score)
}

#[cfg(test)]
mod tests {
    use crate::testutil::project;
    use crate::tree::fuzzy_score;
    use crate::*;

    fn score(query: &str, candidate: &str) -> Option<i64> {
        fuzzy_score(&query.chars().collect::<Vec<_>>(), candidate)
    }

    #[test]
    fn file_name_matches_beat_matches_spread_over_folders() {
        // The "c" of "src/" must not be spent on "cart": the folder costs nothing.
        assert_eq!(score("cart", "src/cart.js"), score("cart", "test/cart.js"));
        assert!(score("cart", "src/cart.js").unwrap() > score("cart", "scripts/acart.js").unwrap());
        let (ws, _) = project(
            "fuzzy",
            &[("src/cart.js", ""), ("test/cart.test.js", ""), ("scripts/care.rs", ""), ("src/format.js", "")],
        );
        let found = ws.find_files("cart", 10);
        assert_eq!(found, ["src/cart.js", "test/cart.test.js"], "{found:?}");
        // Queries that span folders still match the whole path.
        assert_eq!(ws.find_files("srcfor", 10).first().map(String::as_str), Some("src/format.js"));
    }

    #[test]
    fn folder_hints_without_separator_rank_across_folders() {
        // Every candidate is scored over the same alignments, so a folder hint
        // ("src" + "store") beats a longer file name that merely contains the letters.
        let store = "crates/registry/src/store.rs";
        let search_store = "apps/desktop/src/features/editor/searchStore.ts";
        assert!(score("srcstore", store).unwrap() > score("srcstore", search_store).unwrap());
        let edit = "crates/agent/src/edit.rs";
        let roles_editor = "apps/desktop/src/features/settings/sections/RolesEditor.tsx";
        assert!(score("sedit", edit).unwrap() > score("sedit", roles_editor).unwrap());
        let (ws, _) = project(
            "fuzzy-folders",
            &[
                (store, ""),
                (search_store, ""),
                (edit, ""),
                (roles_editor, ""),
                ("apps/desktop/src/bindings/EditorSettings.ts", ""),
                ("apps/desktop/src/components/ui.tsx", ""),
                ("apps/desktop/src/components/ui.module.css", ""),
                ("apps/desktop/src/bindings/CpuInfo.ts", ""),
            ],
        );
        assert_eq!(ws.find_files("srcstore", 2), [store, search_store]);
        assert_eq!(ws.find_files("sedit", 1), [edit]);
        assert_eq!(ws.find_files("cui", 1), ["apps/desktop/src/components/ui.tsx"]);
        // Windows-style separators in the query match the stored forward slashes.
        assert_eq!(ws.find_files("src\\store.rs", 1), [store]);
        assert_eq!(ws.find_files("registry\\src\\store", 1), [store]);
    }

    #[test]
    fn non_ascii_folders_keep_the_file_name_bonus_in_place() {
        // 'İ' lower-cases to two chars; positions must come from the lower-cased path.
        assert_eq!(score("cart", "İcra/cart.js"), score("cart", "src/cart.js"));
        assert_eq!(score("cra", "İİcra/x.js"), score("cra", "iicra/x.js"));
        let (ws, _) = project("fuzzy-unicode", &[("İcra/cart.js", ""), ("İcra/acart.js", "")]);
        assert_eq!(ws.find_files("cart", 10), ["İcra/cart.js", "İcra/acart.js"]);
    }

    #[test]
    fn lists_folders_first_and_respects_gitignore() {
        let (ws, _) = project(
            "tree",
            &[
                (".gitignore", "target/\n*.log\n"),
                ("b.rs", ""),
                ("A.md", ""),
                ("src/lib.rs", ""),
                ("target/debug/x", ""),
                ("debug.log", ""),
                (".git/HEAD", "ref"),
                (".github/ci.yml", ""),
            ],
        );
        let names: Vec<_> = ws.list_dir("").unwrap().into_iter().map(|n| n.name).collect();
        assert_eq!(names, vec![".github", "src", ".gitignore", "A.md", "b.rs"]);
        let src = ws.list_dir("src").unwrap();
        assert_eq!(src[0].path, "src/lib.rs");
        assert_eq!(src[0].kind, FileKind::File);
    }

    #[test]
    fn outline_and_file_listing() {
        let (ws, _) = project("outline", &[("src/a.rs", ""), ("src/util/b.rs", ""), ("README.md", "")]);
        let o = ws.outline("", 3, 100).unwrap();
        assert!(o.contains("src/"));
        assert!(o.contains("    b.rs"));
        assert_eq!(ws.list_files("", 10).unwrap(), vec!["README.md", "src/a.rs", "src/util/b.rs"]);
        assert_eq!(ws.list_files("", 1).unwrap().len(), 1);
    }

    #[test]
    fn fuzzy_finder_prefers_file_name_matches() {
        let (ws, _) = project(
            "fuzzy",
            &[("src/editor/main_view.tsx", ""), ("src/main.rs", ""), ("docs/maintenance.md", "")],
        );
        let r = ws.find_files("main", 10);
        assert_eq!(r[0], "src/main.rs");
        assert_eq!(ws.find_files("mvtsx", 10), vec!["src/editor/main_view.tsx"]);
        assert!(ws.find_files("zzz", 10).is_empty());
    }
}
