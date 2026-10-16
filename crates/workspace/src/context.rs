//! Turns `@`-mentions and editor selections into prompt-ready context blocks
//! that fit a token budget. The UI shows exactly these blocks to the user, so
//! nothing is sent to the model that the user cannot see.

use crate::symbols::definition_text;
use crate::{Workspace, WorkspaceError};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum Mention {
    File {
        path: String,
    },
    Folder {
        path: String,
    },
    Symbol {
        name: String,
        /// Disambiguates when the picker already knows the location.
        path: Option<String>,
        line: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Selection {
        path: String,
        start_line: u32,
        end_line: u32,
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ContextKind {
    File,
    Folder,
    Symbol,
    Selection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextItem {
    pub kind: ContextKind,
    /// Short label for chips in the UI, e.g. `main.rs`, `src/`, `parse_config()`.
    pub label: String,
    pub path: Option<String>,
    /// Markdown block exactly as it is sent to the model.
    pub content: String,
    pub tokens: u32,
    pub truncated: bool,
    /// Set when the mention could not be resolved (file missing, binary, ...).
    pub error: Option<String>,
}

/// Rough token estimate for code (~3.5 characters per token).
pub fn estimate_tokens(text: &str) -> u32 {
    (text.chars().count() as f64 / 3.5).ceil() as u32
}

/// Markdown fence language for a path.
pub fn fence_language(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or_default().to_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "swift" => "swift",
        "rb" => "ruby",
        "php" => "php",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" => "markdown",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "sql" => "sql",
        "sh" | "bash" => "bash",
        "ps1" => "powershell",
        "xml" => "xml",
        "vue" => "vue",
        "svelte" => "svelte",
        _ => "",
    }
}

/// Fences `body` with a fence longer than any backtick run inside it.
fn fenced(lang: &str, body: &str) -> String {
    let longest = body
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    format!("{fence}{lang}\n{}\n{fence}", body.trim_end_matches('\n'))
}

/// Cuts `text` to roughly `tokens` tokens on a line boundary.
fn truncate_to_tokens(text: &str, tokens: u32) -> (String, bool) {
    if estimate_tokens(text) <= tokens {
        return (text.to_string(), false);
    }
    let max_chars = (tokens as f64 * 3.5) as usize;
    let mut out = String::new();
    let mut shown = 0;
    let total = text.lines().count();
    for line in text.lines() {
        if out.chars().count() + line.chars().count() + 1 > max_chars {
            break;
        }
        out.push_str(line);
        out.push('\n');
        shown += 1;
    }
    out.push_str(&format!("… ({} more lines not included)\n", total - shown));
    (out, true)
}

fn error_item(kind: ContextKind, label: String, path: Option<String>, e: impl ToString) -> ContextItem {
    ContextItem {
        kind,
        label,
        path,
        content: String::new(),
        tokens: 0,
        truncated: false,
        error: Some(e.to_string()),
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

/// Resolves mentions in priority order (selection, symbol, file, folder) and
/// keeps the total below `budget` tokens.
pub fn resolve_mentions(ws: &Workspace, mentions: &[Mention], budget: u32) -> Vec<ContextItem> {
    let rank = |m: &Mention| match m {
        Mention::Selection { .. } => 0,
        Mention::Symbol { .. } => 1,
        Mention::File { .. } => 2,
        Mention::Folder { .. } => 3,
    };
    let mut order: Vec<usize> = (0..mentions.len()).collect();
    order.sort_by_key(|i| rank(&mentions[*i]));

    let mut remaining = budget;
    let mut items: Vec<(usize, ContextItem)> = Vec::new();
    for i in order {
        let item = resolve_one(ws, &mentions[i], remaining);
        remaining = remaining.saturating_sub(item.tokens);
        items.push((i, item));
    }
    // Present in the order the user mentioned them.
    items.sort_by_key(|(i, _)| *i);
    items.into_iter().map(|(_, item)| item).collect()
}

fn resolve_one(ws: &Workspace, mention: &Mention, budget: u32) -> ContextItem {
    match mention {
        Mention::Selection {
            path,
            start_line,
            end_line,
            text,
        } => {
            let header = format!("Selected code from `{path}` (lines {start_line}-{end_line}):\n");
            let (body, truncated) = truncate_to_tokens(text, budget.saturating_sub(estimate_tokens(&header) + 8));
            let content = format!("{header}{}", fenced(fence_language(path), &body));
            ContextItem {
                kind: ContextKind::Selection,
                label: format!("{}:{}-{}", basename(path), start_line, end_line),
                path: Some(path.clone()),
                tokens: estimate_tokens(&content),
                content,
                truncated,
                error: None,
            }
        }
        Mention::File { path } => match ws.read_text(path) {
            Ok(file) => {
                let header = format!("File `{}`:\n", file.path);
                let (body, truncated) = truncate_to_tokens(&file.content, budget.saturating_sub(estimate_tokens(&header) + 8));
                let content = format!("{header}{}", fenced(fence_language(path), &body));
                ContextItem {
                    kind: ContextKind::File,
                    label: basename(path),
                    path: Some(file.path),
                    tokens: estimate_tokens(&content),
                    content,
                    truncated,
                    error: None,
                }
            }
            Err(e) => error_item(ContextKind::File, basename(path), Some(path.clone()), e),
        },
        Mention::Folder { path } => {
            let outline = match ws.outline(path, 3, 300) {
                Ok(o) => o,
                Err(e) => return error_item(ContextKind::Folder, format!("{}/", basename(path)), Some(path.clone()), e),
            };
            let shown = if path.is_empty() { ws.name() } else { path.clone() };
            let mut content = format!("Folder `{shown}/` structure:\n{}", fenced("", &outline));
            let mut truncated = false;
            // Then the folder's own small text files, as far as the budget allows.
            if let Ok(children) = ws.list_dir(path) {
                for child in children.iter().filter(|c| c.kind == crate::FileKind::File && c.size_bytes.unwrap_or(0) < 16 * 1024) {
                    let Ok(file) = ws.read_text(&child.path) else { continue };
                    let block = format!("\n\nFile `{}`:\n{}", child.path, fenced(fence_language(&child.path), &file.content));
                    if estimate_tokens(&content) + estimate_tokens(&block) > budget {
                        truncated = true;
                        break;
                    }
                    content.push_str(&block);
                }
            }
            if estimate_tokens(&content) > budget {
                let (cut, _) = truncate_to_tokens(&content, budget);
                content = cut;
                truncated = true;
            }
            ContextItem {
                kind: ContextKind::Folder,
                label: format!("{}/", if path.is_empty() { ws.name() } else { basename(path) }),
                path: Some(path.clone()),
                tokens: estimate_tokens(&content),
                content,
                truncated,
                error: None,
            }
        }
        Mention::Symbol { name, path, line } => {
            let found = match (path, line) {
                (Some(p), Some(l)) => Ok(Some((p.clone(), *l))),
                _ => ws
                    .find_symbols(name, 20, 20_000)
                    .map(|v| v.into_iter().find(|s| s.name == *name && path.as_ref().is_none_or(|p| &s.path == p)).map(|s| (s.path, s.line))),
            };
            match found {
                Ok(Some((p, l))) => match ws.read_text(&p) {
                    Ok(file) => {
                        let def = definition_text(&p, &file.content, l, 400);
                        let header = format!("Definition of `{name}` in `{p}` (line {l}):\n");
                        let (body, truncated) = truncate_to_tokens(&def, budget.saturating_sub(estimate_tokens(&header) + 8));
                        let content = format!("{header}{}", fenced(fence_language(&p), &body));
                        ContextItem {
                            kind: ContextKind::Symbol,
                            label: name.clone(),
                            path: Some(p),
                            tokens: estimate_tokens(&content),
                            content,
                            truncated,
                            error: None,
                        }
                    }
                    Err(e) => error_item(ContextKind::Symbol, name.clone(), Some(p), e),
                },
                Ok(None) => error_item(ContextKind::Symbol, name.clone(), path.clone(), WorkspaceError::NotFound(name.clone())),
                Err(e) => error_item(ContextKind::Symbol, name.clone(), path.clone(), e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::project;

    fn ws() -> Workspace {
        project(
            "context",
            &[
                ("src/main.rs", "fn main() {\n    run();\n}\n\nfn run() {\n    println!(\"hi\");\n}\n"),
                ("src/lib.rs", "pub mod x;\n"),
                ("README.md", "# Demo\n```sh\ncargo run\n```\n"),
                ("big.txt", &"line of text\n".repeat(2000)),
            ],
        )
        .0
    }

    #[test]
    fn file_mention_is_fenced_with_language() {
        let items = resolve_mentions(&ws(), &[Mention::File { path: "src/main.rs".into() }], 10_000);
        assert_eq!(items[0].label, "main.rs");
        assert!(items[0].content.starts_with("File `src/main.rs`:\n```rust\nfn main()"));
        assert!(!items[0].truncated);
    }

    #[test]
    fn fences_survive_backticks_in_content() {
        let items = resolve_mentions(&ws(), &[Mention::File { path: "README.md".into() }], 10_000);
        assert!(items[0].content.contains("````markdown"), "{}", items[0].content);
    }

    #[test]
    fn budget_truncates_large_files() {
        let items = resolve_mentions(&ws(), &[Mention::File { path: "big.txt".into() }], 200);
        assert!(items[0].truncated);
        assert!(items[0].tokens <= 230, "{}", items[0].tokens);
        assert!(items[0].content.contains("more lines not included"));
    }

    #[test]
    fn selection_wins_budget_over_files() {
        let mentions = vec![
            Mention::File { path: "big.txt".into() },
            Mention::Selection {
                path: "src/main.rs".into(),
                start_line: 5,
                end_line: 7,
                text: "fn run() {\n    println!(\"hi\");\n}".into(),
            },
        ];
        let items = resolve_mentions(&ws(), &mentions, 300);
        assert_eq!(items[0].kind, ContextKind::File, "order follows the user's mentions");
        assert!(!items[1].truncated, "selection resolved first, gets full budget");
        assert!(items[0].truncated);
        assert!(items.iter().map(|i| i.tokens).sum::<u32>() <= 340);
    }

    #[test]
    fn symbol_and_folder_mentions() {
        let ws = ws();
        let items = resolve_mentions(
            &ws,
            &[
                Mention::Symbol {
                    name: "run".into(),
                    path: None,
                    line: None,
                },
                Mention::Folder { path: "src".into() },
            ],
            10_000,
        );
        assert!(items[0].content.contains("fn run() {\n    println!"), "{}", items[0].content);
        assert!(!items[0].content.contains("fn main"));
        assert_eq!(items[1].label, "src/");
        assert!(items[1].content.contains("main.rs"));
        assert!(items[1].content.contains("File `src/lib.rs`"));
    }

    #[test]
    fn unresolvable_mentions_report_errors() {
        let items = resolve_mentions(
            &ws(),
            &[
                Mention::File { path: "nope.rs".into() },
                Mention::Symbol {
                    name: "doesNotExist".into(),
                    path: None,
                    line: None,
                },
                Mention::File { path: "../escape".into() },
            ],
            1000,
        );
        assert!(items.iter().all(|i| i.error.is_some() && i.tokens == 0));
    }
}
