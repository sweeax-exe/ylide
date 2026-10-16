//! Lightweight symbol search for `@Symbol` mentions.
//!
//! The MVP uses per-language definition patterns (no parser): good enough to
//! find `fn foo`, `class Foo`, `def foo`, `interface Foo` ... in common
//! languages. v1 replaces this with tree-sitter tag queries behind the same API.

use crate::{Result, Workspace};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SymbolKind {
    Function,
    Class,
    Struct,
    Interface,
    Enum,
    Type,
    Constant,
    Module,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub path: String,
    /// 1-based line of the definition.
    pub line: u32,
}

struct LangPatterns {
    extensions: &'static [&'static str],
    patterns: Vec<(Regex, SymbolKind)>,
    /// Brace languages end a definition at the matching `}`; others by indentation.
    braces: bool,
}

fn languages() -> &'static [LangPatterns] {
    static LANGS: OnceLock<Vec<LangPatterns>> = OnceLock::new();
    LANGS.get_or_init(|| {
        let r = |p: &str| Regex::new(p).expect("static symbol regex");
        use SymbolKind::*;
        vec![
            LangPatterns {
                extensions: &["rs"],
                patterns: vec![
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)"), Function),
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)"), Struct),
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)"), Enum),
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)"), Interface),
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)"), Type),
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)\s*:"), Constant),
                    (r(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)"), Module),
                ],
                braces: true,
            },
            LangPatterns {
                extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
                patterns: vec![
                    (r(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)"), Function),
                    (r(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)"), Class),
                    (r(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"), Interface),
                    (r(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*="), Type),
                    (r(r"^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)"), Enum),
                    (r(r"^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"), Function),
                    (r(r"^\s*(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*="), Constant),
                ],
                braces: true,
            },
            LangPatterns {
                extensions: &["py", "pyi"],
                patterns: vec![
                    (r(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)"), Function),
                    (r(r"^\s*class\s+([A-Za-z_]\w*)"), Class),
                    (r(r"^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?="), Constant),
                ],
                braces: false,
            },
            LangPatterns {
                extensions: &["go"],
                patterns: vec![
                    (r(r"^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)"), Function),
                    (r(r"^type\s+([A-Za-z_]\w*)\s+struct"), Struct),
                    (r(r"^type\s+([A-Za-z_]\w*)\s+interface"), Interface),
                    (r(r"^type\s+([A-Za-z_]\w*)"), Type),
                ],
                braces: true,
            },
            LangPatterns {
                extensions: &["java", "kt", "kts", "cs", "scala", "swift", "dart"],
                patterns: vec![
                    (r(r"^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|object|record)\s+([A-Za-z_]\w*)"), Class),
                    (r(r"^\s*(?:(?:public|private|protected|internal)\s+)*(?:interface|protocol)\s+([A-Za-z_]\w*)"), Interface),
                    (r(r"^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)"), Enum),
                    (r(r"^\s*(?:(?:public|private|protected|internal|static|final|override|suspend|async|virtual)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)"), Function),
                    (r(r"^\s*(?:(?:public|private|protected|internal|static|final|override|async|virtual|abstract)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\([^;]*$"), Function),
                ],
                braces: true,
            },
            LangPatterns {
                extensions: &["c", "h", "cc", "cpp", "cxx", "hpp", "hh"],
                patterns: vec![
                    (r(r"^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)\s*\{?\s*$"), Struct),
                    (r(r"^\s*class\s+([A-Za-z_]\w*)"), Class),
                    (r(r"^\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)"), Enum),
                    (r(r"^[A-Za-z_][\w:<>*&\s]*?\s+\**([A-Za-z_][\w:]*)\s*\([^;]*$"), Function),
                ],
                braces: true,
            },
        ]
    })
}

fn language_for(path: &str) -> Option<&'static LangPatterns> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    languages().iter().find(|l| l.extensions.contains(&ext.as_str()))
}

/// Definitions in one file's text.
pub fn symbols_in(path: &str, text: &str) -> Vec<Symbol> {
    let Some(lang) = language_for(path) else { return vec![] };
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.len() > 500 {
            continue;
        }
        for (re, kind) in &lang.patterns {
            if let Some(c) = re.captures(line) {
                out.push(Symbol {
                    name: c[1].to_string(),
                    kind: *kind,
                    path: path.to_string(),
                    line: i as u32 + 1,
                });
                break;
            }
        }
    }
    out
}

/// Extracts the definition starting at `line` (1-based): until the matching
/// closing brace, or until indentation returns to the start level (Python).
pub fn definition_text(path: &str, text: &str, line: u32, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = (line as usize).saturating_sub(1).min(lines.len());
    // include doc comments / decorators directly above
    let mut first = start;
    while first > 0 {
        let prev = lines[first - 1].trim_start();
        if prev.starts_with("///") || prev.starts_with("//") || prev.starts_with('#') || prev.starts_with('@') || prev.starts_with("*") || prev.starts_with("/**") {
            first -= 1;
        } else {
            break;
        }
    }
    let braces = language_for(path).is_none_or(|l| l.braces);
    let mut end = start;
    if braces {
        let mut depth = 0i32;
        let mut opened = false;
        for (i, l) in lines.iter().enumerate().skip(start) {
            for ch in l.chars() {
                match ch {
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' => depth -= 1,
                    _ => {}
                }
            }
            end = i;
            if (opened && depth <= 0) || (!opened && l.trim_end().ends_with(';')) || i - start >= max_lines {
                break;
            }
        }
    } else {
        let indent = |l: &str| l.len() - l.trim_start().len();
        let base = lines.get(start).map(|l| indent(l)).unwrap_or(0);
        for (i, l) in lines.iter().enumerate().skip(start + 1) {
            if !l.trim().is_empty() && indent(l) <= base {
                break;
            }
            end = i;
            if i - start >= max_lines {
                break;
            }
        }
    }
    lines[first..=end.min(lines.len().saturating_sub(1)).max(first)].join("\n")
}

impl Workspace {
    /// Finds symbols whose name contains `query` (case-insensitive); exact and
    /// prefix matches first. Scans at most `max_files` source files.
    pub fn find_symbols(&self, query: &str, limit: usize, max_files: usize) -> Result<Vec<Symbol>> {
        let q = query.to_lowercase();
        let mut found = Vec::new();
        for path in self.list_files("", max_files)? {
            if language_for(&path).is_none() {
                continue;
            }
            let Ok(file) = self.read_text_limited(&path, 1024 * 1024) else { continue };
            if !q.is_empty() && !file.content.to_lowercase().contains(&q) {
                continue;
            }
            found.extend(symbols_in(&path, &file.content).into_iter().filter(|s| s.name.to_lowercase().contains(&q)));
        }
        found.sort_by_key(|s| {
            let n = s.name.to_lowercase();
            (if n == q { 0 } else if n.starts_with(&q) { 1 } else { 2 }, s.name.len(), s.path.clone(), s.line)
        });
        found.truncate(limit);
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::project;

    #[test]
    fn finds_rust_and_ts_definitions() {
        let rs = "pub struct Config {\n    a: u32,\n}\n\npub(crate) async fn load_config() -> Config {\n    todo()\n}\nconst MAX_SIZE: usize = 3;\n";
        let syms = symbols_in("src/config.rs", rs);
        let names: Vec<_> = syms.iter().map(|s| (s.name.as_str(), s.kind, s.line)).collect();
        assert_eq!(names, vec![("Config", SymbolKind::Struct, 1), ("load_config", SymbolKind::Function, 5), ("MAX_SIZE", SymbolKind::Constant, 8)]);

        let ts = "export interface User { id: string }\nexport const fetchUser = async (id: string) => {\n};\nexport default class Store {}\ntype Id = string;\n";
        let names: Vec<_> = symbols_in("a.ts", ts).into_iter().map(|s| (s.name, s.kind)).collect();
        assert_eq!(
            names,
            vec![
                ("User".to_string(), SymbolKind::Interface),
                ("fetchUser".to_string(), SymbolKind::Function),
                ("Store".to_string(), SymbolKind::Class),
                ("Id".to_string(), SymbolKind::Type)
            ]
        );
    }

    #[test]
    fn python_definitions_and_body_extraction() {
        let py = "import os\n\n@cache\ndef compute(x):\n    y = x\n\n    return y\n\ndef other():\n    pass\n";
        let syms = symbols_in("m.py", py);
        assert_eq!(syms[0].name, "compute");
        let body = definition_text("m.py", py, syms[0].line, 50);
        assert!(body.starts_with("@cache\ndef compute"));
        assert!(body.contains("return y"));
        assert!(!body.contains("def other"));
    }

    #[test]
    fn brace_body_extraction_stops_at_matching_brace() {
        let rs = "/// Docs\nfn a() {\n    if x { y }\n}\nfn b() {}\n";
        let body = definition_text("x.rs", rs, 2, 50);
        assert_eq!(body, "/// Docs\nfn a() {\n    if x { y }\n}");
    }

    #[test]
    fn workspace_symbol_search_ranks_exact_first() {
        let (ws, _) = project(
            "symbols",
            &[("src/a.rs", "fn parse_config() {}\nfn parse() {}\n"), ("web/b.ts", "export function parser() {}\n"), ("README.md", "parse")],
        );
        let r = ws.find_symbols("parse", 10, 1000).unwrap();
        assert_eq!(r[0].name, "parse");
        assert_eq!(r.len(), 3);
    }
}
