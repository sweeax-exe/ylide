//! Search/replace edits (the format local models handle most reliably) and diffs.
//!
//! `old_text` must identify exactly one location. Matching is tried in order:
//! 1. exact,
//! 2. after normalising CRLF to LF,
//! 3. without line-number prefixes the model copied from tool output (`12| x`),
//! 4. line-wise ignoring trailing whitespace,
//! 5. line-wise ignoring indentation (the replacement is re-indented to the
//!    indentation found in the file),
//! 6. with typographic punctuation normalised (curly quotes, dashes, NBSP).
//!
//! When nothing matches, the error names the closest region so the model can
//! re-read exactly that part.
//!
//! Each step only accepts a *unique* match, so a sloppy model can never edit the
//! wrong place silently.

use similar::TextDiff;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditError {
    #[error("old_text was not found in the file.{}", closest_hint(.closest))]
    NotFound { closest: Option<(usize, usize)> },
    #[error("old_text matches {0} places. Include more surrounding lines so it is unique, or set replace_all.")]
    Ambiguous(usize),
    #[error("old_text must not be empty. Use write_file to create or overwrite a whole file.")]
    Empty,
    #[error("old_text and new_text are identical; nothing to change.")]
    NoChange,
}

fn closest_hint(closest: &Option<(usize, usize)>) -> String {
    match closest {
        Some((a, b)) => format!(" The most similar text is at lines {a}-{b}; re-read those lines and copy them exactly."),
        None => " Re-read the file and copy the exact lines you want to replace.".into(),
    }
}

/// Removes `12| `, `12: ` or `12→` prefixes when every non-empty line has one.
fn strip_line_numbers(text: &str) -> Option<String> {
    let strip = |line: &str| -> Option<String> {
        let t = line.trim_start();
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let rest = &t[digits..];
        let rest = rest.strip_prefix('|').or_else(|| rest.strip_prefix(':')).or_else(|| rest.strip_prefix('→'))?;
        Some(rest.strip_prefix(' ').unwrap_or(rest).to_string())
    };
    let mut out = Vec::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            out.push(String::new());
        } else {
            out.push(strip(line)?);
        }
    }
    Some(out.join("\n"))
}

/// Maps typographic characters to their ASCII equivalents.
fn normalize_punctuation(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '‘' | '’' | '‚' | '′' => '\'',
            '“' | '”' | '„' | '″' => '"',
            '–' | '—' | '−' => '-',
            ' ' | ' ' | ' ' => ' ',
            other => other,
        })
        .collect()
}

/// 1-based line range of the file window most similar to `old` (≥ half the lines equal).
fn closest_region(file_lines: &[&str], old_lines: &[&str]) -> Option<(usize, usize)> {
    let n = old_lines.len();
    if n == 0 || n > file_lines.len() {
        return None;
    }
    let wanted: Vec<String> = old_lines.iter().map(|l| l.trim().to_string()).collect();
    let mut best = (0usize, 0usize);
    for start in 0..=file_lines.len() - n {
        let equal = (0..n).filter(|k| !wanted[*k].is_empty() && file_lines[start + k].trim() == wanted[*k]).count();
        if equal > best.1 {
            best = (start, equal);
        }
    }
    let significant = wanted.iter().filter(|l| !l.is_empty()).count().max(1);
    (best.1 * 2 >= significant && best.1 > 0).then_some((best.0 + 1, best.0 + n))
}

/// Returns the edited content.
pub fn apply_edit(content: &str, old_text: &str, new_text: &str, replace_all: bool) -> Result<String, EditError> {
    match apply_edit_inner(content, old_text, new_text, replace_all) {
        Err(EditError::NotFound { .. }) => {}
        other => return other,
    }
    // 3: line numbers copied from read_file output
    if let Some(stripped) = strip_line_numbers(&old_text.replace("\r\n", "\n")) {
        let new_stripped = strip_line_numbers(&new_text.replace("\r\n", "\n")).unwrap_or_else(|| new_text.to_string());
        match apply_edit_inner(content, &stripped, &new_stripped, replace_all) {
            Err(EditError::NotFound { .. }) => {}
            other => return other,
        }
    }
    // 6: typographic punctuation
    let normalized_content = normalize_punctuation(content);
    let normalized_old = normalize_punctuation(old_text);
    if normalized_content == content && normalized_old != old_text {
        match apply_edit_inner(content, &normalized_old, new_text, replace_all) {
            Err(EditError::NotFound { .. }) => {}
            other => return other,
        }
    }
    let lf = content.replace("\r\n", "\n");
    let file_lines: Vec<&str> = lf.split('\n').collect();
    let old = old_text.replace("\r\n", "\n");
    let old_lines: Vec<&str> = old.trim_matches('\n').split('\n').collect();
    Err(EditError::NotFound {
        closest: closest_region(&file_lines, &old_lines),
    })
}

fn apply_edit_inner(content: &str, old_text: &str, new_text: &str, replace_all: bool) -> Result<String, EditError> {
    if old_text.is_empty() {
        return Err(EditError::Empty);
    }
    if old_text == new_text {
        return Err(EditError::NoChange);
    }
    let crlf = content.contains("\r\n");
    let lf_content = content.replace("\r\n", "\n");
    let old = old_text.replace("\r\n", "\n");
    let new = new_text.replace("\r\n", "\n");
    let restore = |s: String| if crlf { s.replace('\n', "\r\n") } else { s };

    // 1 + 2: exact (on LF-normalised text, which also covers exact CRLF input)
    let count = lf_content.matches(&old).count();
    if count == 1 || (count > 1 && replace_all) {
        return Ok(restore(lf_content.replace(&old, &new)));
    }
    if count > 1 {
        return Err(EditError::Ambiguous(count));
    }

    // 3 + 4: line-based fuzzy matching
    let file_lines: Vec<&str> = lf_content.split('\n').collect();
    let old_lines: Vec<&str> = old.trim_matches('\n').split('\n').collect();
    for strategy in [Strategy::TrailingWhitespace, Strategy::Indentation] {
        let hits = find_line_matches(&file_lines, &old_lines, strategy);
        match hits.len() {
            0 => continue,
            n if n > 1 && !replace_all => return Err(EditError::Ambiguous(n)),
            _ => {
                let mut out: Vec<String> = Vec::new();
                let mut cursor = 0;
                for start in hits {
                    out.extend(file_lines[cursor..start].iter().map(|s| s.to_string()));
                    let replacement = match strategy {
                        Strategy::TrailingWhitespace => new.trim_matches('\n').to_string(),
                        Strategy::Indentation => reindent(&new, &old_lines, &file_lines[start..start + old_lines.len()]),
                    };
                    // An empty replacement deletes the matched lines entirely.
                    if !replacement.is_empty() {
                        out.extend(replacement.split('\n').map(str::to_string));
                    }
                    cursor = start + old_lines.len();
                }
                out.extend(file_lines[cursor..].iter().map(|s| s.to_string()));
                return Ok(restore(out.join("\n")));
            }
        }
    }
    Err(EditError::NotFound { closest: None })
}

#[derive(Clone, Copy, PartialEq)]
enum Strategy {
    TrailingWhitespace,
    Indentation,
}

fn find_line_matches(file: &[&str], needle: &[&str], strategy: Strategy) -> Vec<usize> {
    if needle.is_empty() || needle.len() > file.len() {
        return vec![];
    }
    let norm = |s: &str| match strategy {
        Strategy::TrailingWhitespace => s.trim_end().to_string(),
        Strategy::Indentation => s.trim().to_string(),
    };
    let needle: Vec<String> = needle.iter().map(|l| norm(l)).collect();
    let mut hits = Vec::new();
    let mut i = 0;
    while i + needle.len() <= file.len() {
        if (0..needle.len()).all(|k| norm(file[i + k]) == needle[k]) {
            hits.push(i);
            i += needle.len(); // non-overlapping
        } else {
            i += 1;
        }
    }
    hits
}

fn indent_of(s: &str) -> &str {
    &s[..s.len() - s.trim_start().len()]
}

/// Shifts `new` so that its first non-empty line gets the indentation the matched
/// block has in the file, keeping relative indentation inside `new`.
fn reindent(new: &str, old_lines: &[&str], matched: &[&str]) -> String {
    let model_indent = old_lines.iter().find(|l| !l.trim().is_empty()).map(|l| indent_of(l)).unwrap_or("");
    let file_indent = matched.iter().find(|l| !l.trim().is_empty()).map(|l| indent_of(l)).unwrap_or("");
    new.trim_matches('\n')
        .split('\n')
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else if let Some(rest) = line.strip_prefix(model_indent) {
                format!("{file_indent}{rest}")
            } else {
                format!("{file_indent}{}", line.trim_start())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Unified diff with 3 lines of context (`a/path` -> `b/path`).
pub fn unified_diff(path: &str, before: &str, after: &str) -> String {
    let before = before.replace("\r\n", "\n");
    let after = after.replace("\r\n", "\n");
    TextDiff::from_lines(&before, &after)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string()
}

/// (+added, -removed) line counts.
pub fn diff_stats(before: &str, after: &str) -> (usize, usize) {
    let before = before.replace("\r\n", "\n");
    let after = after.replace("\r\n", "\n");
    let diff = TextDiff::from_lines(&before, &after);
    let mut added = 0;
    let mut removed = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n";

    #[test]
    fn exact_replacement() {
        let out = apply_edit(SRC, "let x = 1;", "let x = 2;", false).unwrap();
        assert_eq!(out, SRC.replace("1;", "2;"));
    }

    #[test]
    fn preserves_crlf() {
        let crlf = SRC.replace('\n', "\r\n");
        let out = apply_edit(&crlf, "let x = 1;\n    println!", "let x = 3;\n    print!", false).unwrap();
        assert!(out.contains("let x = 3;\r\n    print!(\"{x}\");\r\n"));
        assert!(!out.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn tolerates_trailing_whitespace() {
        let src = "a = 1   \nb = 2\n";
        let out = apply_edit(src, "a = 1\nb = 2", "a = 10\nb = 20", false).unwrap();
        assert_eq!(out, "a = 10\nb = 20\n");
    }

    #[test]
    fn reindents_when_model_got_indentation_wrong() {
        let src = "impl A {\n        fn f(&self) {\n            todo!()\n        }\n}\n";
        let old = "fn f(&self) {\n    todo!()\n}";
        let new = "fn f(&self) {\n    42\n}";
        let out = apply_edit(src, old, new, false).unwrap();
        assert_eq!(out, "impl A {\n        fn f(&self) {\n            42\n        }\n}\n");
    }

    #[test]
    fn ambiguous_and_missing_are_errors() {
        let src = "x();\nx();\n";
        assert_eq!(apply_edit(src, "x();", "y();", false), Err(EditError::Ambiguous(2)));
        assert_eq!(apply_edit(src, "x();", "y();", true).unwrap(), "y();\ny();\n");
        assert!(matches!(apply_edit(src, "z();", "y();", false), Err(EditError::NotFound { .. })));
        assert_eq!(apply_edit(src, "", "y();", false), Err(EditError::Empty));
        assert_eq!(apply_edit(src, "x();", "x();", false), Err(EditError::NoChange));
    }

    #[test]
    fn deleting_lines() {
        let src = "keep\n  drop me\nkeep too\n";
        assert_eq!(apply_edit(src, "  drop me\n", "", false).unwrap(), "keep\nkeep too\n");
        // fuzzy (indentation-insensitive) match deletes whole lines
        assert_eq!(apply_edit(src, "drop me   ", "", false).unwrap(), "keep\nkeep too\n");
    }

    #[test]
    fn strips_copied_line_numbers() {
        let old = "2|     let x = 1;\n3|     println!(\"{x}\");";
        let out = apply_edit(SRC, old, "    let x = 5;\n    println!(\"{x}\");", false).unwrap();
        assert!(out.contains("let x = 5;"));
    }

    #[test]
    fn normalizes_typographic_quotes() {
        let src = "say(\"hello\");\n";
        let out = apply_edit(src, "say(\u{201C}hello\u{201D});", "say(\"bye\");", false).unwrap();
        assert_eq!(out, "say(\"bye\");\n");
    }

    #[test]
    fn not_found_points_to_closest_region() {
        let src = "a\nb\nfn compute(x: i32) {\n    x * 2\n}\nz\n";
        let err = apply_edit(src, "fn compute(x: i32) {\n    x * 3\n}", "y", false).unwrap_err();
        assert_eq!(err, EditError::NotFound { closest: Some((3, 5)) });
        assert!(err.to_string().contains("lines 3-5"));
    }

    #[test]
    fn diff_output() {
        let after = SRC.replace("1;", "2;");
        let d = unified_diff("src/main.rs", SRC, &after);
        assert!(d.starts_with("--- a/src/main.rs\n+++ b/src/main.rs\n"));
        assert!(d.contains("-    let x = 1;\n+    let x = 2;\n"));
        assert_eq!(diff_stats(SRC, &after), (1, 1));
    }
}
