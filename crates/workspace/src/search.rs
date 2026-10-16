//! Project-wide text search built on ripgrep's libraries (`grep-searcher`,
//! `grep-regex`, `ignore`): respects ignore files, skips binaries, runs in parallel.

use crate::{Result, Workspace, WorkspaceError};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, SearcherBuilder, sinks::UTF8};
use ignore::WalkState;
use ignore::overrides::OverrideBuilder;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchQuery {
    pub pattern: String,
    /// Treat `pattern` as a regular expression (otherwise literal text).
    #[serde(default)]
    pub regex: bool,
    /// `None` = smart case (case-insensitive unless the pattern has upper case).
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub whole_word: bool,
    /// Glob filters like `*.rs`, or with a leading `!` to exclude a folder such as tests.
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default = "default_max")]
    pub max_results: u32,
}

fn default_max() -> u32 {
    500
}

impl SearchQuery {
    pub fn literal(pattern: &str) -> Self {
        Self {
            pattern: pattern.to_string(),
            regex: false,
            case_sensitive: None,
            whole_word: false,
            globs: vec![],
            max_results: default_max(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchMatch {
    pub line_number: u32,
    /// The matching line (trimmed to 400 characters).
    pub line: String,
    /// Character ranges of the matches within `line`.
    pub ranges: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileMatch {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchResults {
    pub files: Vec<FileMatch>,
    pub total_matches: u32,
    /// `max_results` was reached; there may be more.
    pub truncated: bool,
}

const MAX_LINE_CHARS: usize = 400;

impl Workspace {
    pub fn search(&self, query: &SearchQuery) -> Result<SearchResults> {
        if query.pattern.is_empty() {
            return Ok(SearchResults {
                files: vec![],
                total_matches: 0,
                truncated: false,
            });
        }
        let pattern = if query.regex { query.pattern.clone() } else { regex::escape(&query.pattern) };
        let mut mb = RegexMatcherBuilder::new();
        match query.case_sensitive {
            Some(true) => mb.case_insensitive(false),
            Some(false) => mb.case_insensitive(true),
            None => mb.case_smart(true),
        };
        mb.word(query.whole_word);
        let matcher = mb.build(&pattern).map_err(|e| WorkspaceError::Pattern(e.to_string()))?;

        let mut walker = self.walker(self.root());
        if !query.globs.is_empty() {
            let mut ob = OverrideBuilder::new(self.root());
            for g in &query.globs {
                ob.add(g).map_err(|e| WorkspaceError::Pattern(e.to_string()))?;
            }
            walker.overrides(ob.build().map_err(|e| WorkspaceError::Pattern(e.to_string()))?);
        }

        let results = Mutex::new(Vec::<FileMatch>::new());
        let total = AtomicUsize::new(0);
        let full = AtomicBool::new(false);
        let max = query.max_results as usize;

        walker.build_parallel().run(|| {
            let matcher = matcher.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .line_number(true)
                .build();
            let (results, total, full) = (&results, &total, &full);
            Box::new(move |entry| {
                if full.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let mut matches = Vec::new();
                let _ = searcher.search_path(
                    &matcher,
                    entry.path(),
                    UTF8(|line_number, line| {
                        if total.fetch_add(1, Ordering::Relaxed) >= max {
                            full.store(true, Ordering::Relaxed);
                            return Ok(false);
                        }
                        let line = line.trim_end_matches(['\r', '\n']);
                        let mut ranges = Vec::new();
                        let _ = matcher.find_iter(line.as_bytes(), |m| {
                            let start = line[..m.start()].chars().count() as u32;
                            let end = start + line[m.start()..m.end()].chars().count() as u32;
                            ranges.push((start, end));
                            true
                        });
                        let shown: String = line.chars().take(MAX_LINE_CHARS).collect();
                        matches.push(SearchMatch {
                            line_number: line_number as u32,
                            line: shown,
                            ranges,
                        });
                        Ok(true)
                    }),
                );
                if !matches.is_empty()
                    && let Some(path) = self.relative(entry.path())
                {
                    results.lock().unwrap_or_else(|e| e.into_inner()).push(FileMatch { path, matches });
                }
                WalkState::Continue
            })
        });

        let mut files = results.into_inner().unwrap_or_else(|e| e.into_inner());
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let total_matches: usize = files.iter().map(|f| f.matches.len()).sum();
        Ok(SearchResults {
            files,
            total_matches: total_matches as u32,
            truncated: full.load(Ordering::Relaxed),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::testutil::project;
    use crate::*;

    fn ws() -> Workspace {
        project(
            "search",
            &[
                (".gitignore", "build/\n"),
                ("src/a.rs", "fn alpha() {}\nlet Alpha = 1;\n// ALPHA\n"),
                ("src/b.ts", "const beta = 'alpha beta';\n"),
                ("build/out.rs", "fn alpha() {}\n"),
                ("bin.dat", "alpha\0binary"),
                ("unicode.txt", "äöü alpha\n"),
            ],
        )
        .0
    }

    #[test]
    fn smart_case_literal_search() {
        let r = ws().search(&SearchQuery::literal("alpha")).unwrap();
        let paths: Vec<_> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["src/a.rs", "src/b.ts", "unicode.txt"], "ignored and binary files are skipped");
        assert_eq!(r.files[0].matches.len(), 3, "lower-case pattern is case-insensitive");
        let upper = ws().search(&SearchQuery::literal("Alpha")).unwrap();
        assert_eq!(upper.total_matches, 1, "upper case makes it case-sensitive");
    }

    #[test]
    fn reports_character_ranges() {
        let r = ws().search(&SearchQuery::literal("alpha")).unwrap();
        let u = r.files.iter().find(|f| f.path == "unicode.txt").unwrap();
        assert_eq!(u.matches[0].ranges, vec![(4, 9)], "ranges count characters, not bytes");
        assert_eq!(u.matches[0].line_number, 1);
    }

    #[test]
    fn regex_globs_and_limits() {
        let mut q = SearchQuery::literal(r"fn \w+\(");
        q.regex = true;
        assert_eq!(ws().search(&q).unwrap().total_matches, 1);
        let mut q = SearchQuery::literal("alpha");
        q.globs = vec!["*.ts".into()];
        let r = ws().search(&q).unwrap();
        assert_eq!(r.files.len(), 1);
        let mut q = SearchQuery::literal("alpha");
        q.max_results = 2;
        let r = ws().search(&q).unwrap();
        assert!(r.truncated);
        assert!(r.total_matches <= 2);
    }

    #[test]
    fn invalid_regex_is_reported() {
        let mut q = SearchQuery::literal("(unclosed");
        q.regex = true;
        assert!(matches!(ws().search(&q), Err(WorkspaceError::Pattern(_))));
    }
}
