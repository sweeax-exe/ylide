//! Reading `SKILL.md`: the YAML frontmatter and the Markdown body.
//!
//! Skills use a small part of YAML: `key: value` pairs, quoted strings, block
//! scalars (`|`, `>`) for long descriptions, lists, and a `metadata` map of
//! strings. This parser reads exactly that, so no YAML library is needed.
//! What it cannot read is an error with a line number, never a guess.

use crate::{Result, SkillError};
use std::collections::BTreeMap;

/// Upper bound for SKILL.md.
pub const MAX_SKILL_MD_BYTES: usize = 256 * 1024;
/// Upper bound for the frontmatter block.
const MAX_FRONTMATTER_BYTES: usize = 16 * 1024;
pub const MAX_NAME_CHARS: usize = 64;
/// Longest description kept (the format allows 1024 characters).
pub const MAX_DESCRIPTION_CHARS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Text(String),
    List(Vec<String>),
    Map(BTreeMap<String, String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub fields: BTreeMap<String, Value>,
    /// Everything after the frontmatter.
    pub body: String,
}

impl Document {
    /// A field as one line of text; `None` when missing or empty.
    pub fn text(&self, key: &str) -> Option<String> {
        let text = match self.fields.get(key)? {
            Value::Text(t) => t.clone(),
            Value::List(items) => items.join(", "),
            Value::Map(_) => return None,
        };
        let text = collapse(&text);
        (!text.is_empty()).then_some(text)
    }
}

/// What Ylide uses from the frontmatter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    /// `metadata.version` (or a top-level `version`), if the author keeps one.
    pub version: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

/// Parses and checks a whole SKILL.md.
pub fn read(text: &str) -> Result<(SkillMeta, Document)> {
    if text.len() > MAX_SKILL_MD_BYTES {
        return Err(SkillError::TooLarge(format!("SKILL.md is larger than {} KB", MAX_SKILL_MD_BYTES / 1024)));
    }
    let doc = parse(text)?;
    Ok((meta(&doc)?, doc))
}

/// Splits SKILL.md into frontmatter fields and body.
pub fn parse(text: &str) -> Result<Document> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().ok_or(SkillError::NoFrontmatter)?;
    if first.trim_end() != "---" {
        return Err(SkillError::NoFrontmatter);
    }
    let mut offset = first.len();
    let mut block = Vec::new();
    let mut closed = false;
    for line in lines {
        offset += line.len();
        let line = line.trim_end_matches(['\n', '\r']);
        if matches!(line.trim_end(), "---" | "...") {
            closed = true;
            break;
        }
        block.push(line);
    }
    if !closed {
        return Err(SkillError::NoFrontmatter);
    }
    if offset > MAX_FRONTMATTER_BYTES {
        return Err(SkillError::TooLarge(format!("the frontmatter is larger than {} KB", MAX_FRONTMATTER_BYTES / 1024)));
    }
    Ok(Document { fields: fields(&block)?, body: text[offset..].to_string() })
}

/// The checked fields Ylide uses.
pub fn meta(doc: &Document) -> Result<SkillMeta> {
    let name = doc.text("name").ok_or(SkillError::MissingName)?;
    if !valid_name(&name) {
        return Err(SkillError::InvalidName(name));
    }
    let description = doc.text("description").ok_or(SkillError::MissingDescription)?;
    let metadata = match doc.fields.get("metadata") {
        Some(Value::Map(m)) => m.clone(),
        _ => BTreeMap::new(),
    };
    let version = metadata.get("version").map(|v| collapse(v)).filter(|v| !v.is_empty()).or_else(|| doc.text("version"));
    Ok(SkillMeta {
        name,
        description: clip(&description, MAX_DESCRIPTION_CHARS),
        license: doc.text("license"),
        compatibility: doc.text("compatibility"),
        version,
        metadata,
    })
}

/// Lowercase letters, digits and single hyphens, as the format asks; also
/// never a name Windows reserves for devices, since it becomes a folder.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_CHARS
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && !reserved_on_windows(name)
}

/// Device names Windows reserves for every folder (`con`, `nul`, `com1`, ...).
pub(crate) fn reserved_on_windows(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default().trim_end().to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit())
}

/// Whitespace runs as single spaces.
pub(crate) fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `max` characters, ending in "…" when cut.
pub(crate) fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

fn fields(lines: &[&str]) -> Result<BTreeMap<String, Value>> {
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        // Line 1 of the file is the opening '---'.
        let number = i + 2;
        i += 1;
        if is_blank_or_comment(line) {
            continue;
        }
        if indent(line) > 0 {
            return Err(SkillError::Syntax(number));
        }
        let (key, rest) = key_value(line).ok_or(SkillError::Syntax(number))?;
        let start = i;
        while i < lines.len() && (lines[i].trim().is_empty() || indent(lines[i]) > 0) {
            i += 1;
        }
        let value = value(rest, &lines[start..i]).ok_or(SkillError::Syntax(number))?;
        out.insert(key.to_string(), value);
    }
    Ok(out)
}

fn is_blank_or_comment(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

fn key_value(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    let key = line[..colon].trim();
    let rest = &line[colon + 1..];
    let valid_key = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (valid_key && (rest.is_empty() || rest.starts_with([' ', '\t']))).then(|| (key, rest.trim()))
}

/// The value after `key:`, with the indented lines that follow it.
fn value(rest: &str, block: &[&str]) -> Option<Value> {
    if let Some(literal) = block_indicator(rest) {
        return Some(Value::Text(block_scalar(literal, block)));
    }
    if rest.is_empty() || rest.starts_with('#') {
        let Some(first) = block.iter().map(|l| l.trim_start()).find(|l| !is_blank_or_comment(l)) else {
            return Some(Value::Text(String::new()));
        };
        if first == "-" || first.starts_with("- ") {
            return list(block);
        }
        if key_value(first).is_some() {
            return map(block);
        }
        return scalar(&continued("", block)).map(Value::Text);
    }
    let text = continued(rest, block);
    if text.starts_with('[') {
        let inner = text.strip_prefix('[')?.trim_end().strip_suffix(']')?;
        return split_flow(inner).iter().map(|item| scalar(item)).collect::<Option<Vec<_>>>().map(Value::List);
    }
    if text.starts_with('{') {
        let inner = text.strip_prefix('{')?.trim_end().strip_suffix('}')?;
        let mut map = BTreeMap::new();
        for item in split_flow(inner) {
            let (k, v) = key_value(item.trim())?;
            map.insert(k.to_string(), scalar(v)?);
        }
        return Some(Value::Map(map));
    }
    scalar(&text).map(Value::Text)
}

/// `Some(true)` for `|`, `Some(false)` for `>` (with optional chomping and indent indicators).
fn block_indicator(rest: &str) -> Option<bool> {
    let literal = match rest.chars().next()? {
        '|' => true,
        '>' => false,
        _ => return None,
    };
    let tail = rest[1..].trim_start_matches(|c: char| c == '-' || c == '+' || c.is_ascii_digit()).trim();
    (tail.is_empty() || tail.starts_with('#')).then_some(literal)
}

fn block_scalar(literal: bool, block: &[&str]) -> String {
    let base = block.iter().filter(|l| !l.trim().is_empty()).map(|l| indent(l)).min().unwrap_or(0);
    let lines = block.iter().map(|l| if l.trim().is_empty() { "" } else { &l[base..] });
    let text = if literal {
        lines.collect::<Vec<_>>().join("\n")
    } else {
        // Folded: lines join with spaces; an empty line is a line break.
        let mut out = String::new();
        let mut after_break = true;
        for line in lines {
            if line.is_empty() {
                out.push('\n');
                after_break = true;
                continue;
            }
            if !after_break {
                out.push(' ');
            }
            out.push_str(line);
            after_break = false;
        }
        out
    };
    text.trim_start_matches('\n').trim_end().to_string()
}

/// The first line's text and the indented lines after it, joined with spaces.
fn continued(first: &str, block: &[&str]) -> String {
    std::iter::once(first)
        .chain(block.iter().map(|l| l.trim()))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn list(block: &[&str]) -> Option<Value> {
    let base = block.iter().filter(|l| !is_blank_or_comment(l)).map(|l| indent(l)).min()?;
    let mut items: Vec<String> = Vec::new();
    for line in block.iter().filter(|l| !is_blank_or_comment(l)) {
        let t = line.trim();
        if indent(line) == base {
            let item = t.strip_prefix('-')?;
            if !item.is_empty() && !item.starts_with([' ', '\t']) {
                return None;
            }
            items.push(scalar(item)?);
        } else {
            let last = items.last_mut()?;
            last.push(' ');
            last.push_str(t);
        }
    }
    Some(Value::List(items))
}

fn map(block: &[&str]) -> Option<Value> {
    let base = block.iter().filter(|l| !is_blank_or_comment(l)).map(|l| indent(l)).min()?;
    let mut map = BTreeMap::new();
    let mut last: Option<String> = None;
    for line in block.iter().filter(|l| !is_blank_or_comment(l)) {
        if indent(line) == base {
            let (k, v) = key_value(line.trim())?;
            map.insert(k.to_string(), scalar(v)?);
            last = Some(k.to_string());
        } else {
            // A longer value going on in the next, deeper lines.
            let value = map.get_mut(last.as_ref()?)?;
            if !value.is_empty() {
                value.push(' ');
            }
            value.push_str(&scalar(line.trim())?);
        }
    }
    Some(Value::Map(map))
}

/// Splits `a, "b, c", d` at the commas outside quotes.
fn split_flow(inner: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut quote: Option<char> = None;
    let mut start = 0;
    for (i, c) in inner.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, ',') => {
                parts.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&inner[start..]);
    parts.into_iter().map(str::trim).filter(|p| !p.is_empty()).collect()
}

fn scalar(text: &str) -> Option<String> {
    let s = text.trim();
    if let Some(inner) = s.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return Some(out),
                '\\' => match chars.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'u' => {
                        let hex: String = chars.by_ref().take(4).collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    }
                    c @ ('"' | '\\' | '/' | ' ') => out.push(c),
                    other => {
                        out.push('\\');
                        out.push(other);
                    }
                },
                c => out.push(c),
            }
        }
        return None;
    }
    if let Some(inner) = s.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    out.push('\'');
                    continue;
                }
                return Some(out);
            }
            out.push(c);
        }
        return None;
    }
    // In a plain value a comment starts at " #".
    let plain = s.find(" #").map_or(s, |i| &s[..i]).trim_end();
    Some(if matches!(plain, "~" | "null" | "Null" | "NULL") { String::new() } else { plain.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REA: &str = "---\nname: reverse-engineer-anything\ndescription: Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with REA. Use shipped-artifact or requested runtime evidence to explain features. Skip REA for ordinary source-repository architecture analysis.\nmetadata:\n  version: \"42\"\n---\n\n# REA\n\nUse REA when a claim depends on a shipped binary.\n";

    #[test]
    fn reads_a_real_skill() {
        let (meta, doc) = read(REA).unwrap();
        assert_eq!(meta.name, "reverse-engineer-anything");
        assert!(meta.description.starts_with("Reverse engineer native, managed"));
        assert!(meta.description.ends_with("architecture analysis."));
        assert_eq!(meta.version.as_deref(), Some("42"));
        assert_eq!(meta.metadata.get("version").map(String::as_str), Some("42"));
        assert_eq!(doc.body, "\n# REA\n\nUse REA when a claim depends on a shipped binary.\n");
        assert_eq!(meta.license, None);
    }

    #[test]
    fn windows_line_endings_and_a_byte_order_mark() {
        let text = format!("\u{feff}{}", REA.replace('\n', "\r\n"));
        let (meta, doc) = read(&text).unwrap();
        assert_eq!(meta.name, "reverse-engineer-anything");
        assert_eq!(meta.version.as_deref(), Some("42"));
        assert!(doc.body.starts_with("\r\n# REA"));
    }

    #[test]
    fn block_scalars_quotes_and_comments() {
        let text = "---\n# a comment\nname: 'pdf-tools'\ndescription: >\n  Fills PDF forms\n  and merges files.\n\n  Use for PDFs.\nlicense: \"Apache-2.0 \\\"see\\\" LICENSE\" # trailing comment\ncompatibility: |\n  Needs python3\n    and qpdf\nallowed-tools: Bash(git:*) Read\n---\nBody";
        let (meta, doc) = read(text).unwrap();
        assert_eq!(meta.name, "pdf-tools");
        assert_eq!(meta.description, "Fills PDF forms and merges files. Use for PDFs.");
        assert_eq!(meta.license.as_deref(), Some("Apache-2.0 \"see\" LICENSE"));
        assert_eq!(doc.fields.get("compatibility"), Some(&Value::Text("Needs python3\n  and qpdf".into())));
        assert_eq!(meta.compatibility.as_deref(), Some("Needs python3 and qpdf"));
        assert_eq!(doc.text("allowed-tools").as_deref(), Some("Bash(git:*) Read"));
        assert_eq!(doc.body, "Body");
    }

    #[test]
    fn plain_values_may_go_on_in_indented_lines_and_contain_colons() {
        let text = "---\nname: a\ndescription: Use when: the user asks\n  about invoices, receipts\n  or taxes. # not part of it\nsingle: 'it''s'\n---\n";
        let (meta, doc) = read(text).unwrap();
        assert_eq!(meta.description, "Use when: the user asks about invoices, receipts or taxes.");
        assert_eq!(doc.text("single").as_deref(), Some("it's"));
    }

    #[test]
    fn lists_and_flow_collections() {
        let text = "---\nname: x\ndescription: d\nallowed-tools:\n  - Read\n  - \"Bash(npm test)\"\ntags: [a, \"b, c\", d]\nmetadata: {author: me, version: '1.2'}\n---\n";
        let doc = parse(text).unwrap();
        assert_eq!(doc.fields["allowed-tools"], Value::List(vec!["Read".into(), "Bash(npm test)".into()]));
        assert_eq!(doc.fields["tags"], Value::List(vec!["a".into(), "b, c".into(), "d".into()]));
        let meta = meta(&doc).unwrap();
        assert_eq!(meta.version.as_deref(), Some("1.2"));
        assert_eq!(meta.metadata["author"], "me");
    }

    #[test]
    fn top_level_version_and_long_descriptions() {
        let long = "word ".repeat(400);
        let (meta, _) = read(&format!("---\nname: x\nversion: 3\ndescription: {long}\n---\n")).unwrap();
        assert_eq!(meta.version.as_deref(), Some("3"));
        assert_eq!(meta.description.chars().count(), MAX_DESCRIPTION_CHARS);
        assert!(meta.description.ends_with('…'));
    }

    #[test]
    fn broken_files_are_refused_with_a_reason() {
        assert!(matches!(read("# Just Markdown\n"), Err(SkillError::NoFrontmatter)));
        assert!(matches!(read("---\nname: x\ndescription: d\n"), Err(SkillError::NoFrontmatter)), "never closed");
        assert!(matches!(read("---\ndescription: d\n---\n"), Err(SkillError::MissingName)));
        assert!(matches!(read("---\nname: x\n---\n"), Err(SkillError::MissingDescription)));
        assert!(matches!(read("---\nname: x\ndescription: \"\"\n---\n"), Err(SkillError::MissingDescription)));
        assert!(matches!(read("---\nname: x\ndescription: d\nthis is no pair\n---\n"), Err(SkillError::Syntax(4))));
        assert!(matches!(read("---\nname: x\ndescription: \"open\n---\n"), Err(SkillError::Syntax(3))));
        assert!(matches!(read("---\n  name: x\n---\n"), Err(SkillError::Syntax(2))));
        let huge = format!("---\nname: x\ndescription: d\n---\n{}", "x".repeat(MAX_SKILL_MD_BYTES));
        assert!(matches!(read(&huge), Err(SkillError::TooLarge(_))));
    }

    #[test]
    fn names_follow_the_format() {
        for ok in ["pdf", "reverse-engineer-anything", "a1-b2", "x", &"a".repeat(64), "console", "com10"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "PDF", "my_skill", "-a", "a-", "a--b", "a b", "ä", "a.b", &"a".repeat(65), "con", "nul", "com1", "lpt9", "../x"] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(matches!(read("---\nname: My Skill\ndescription: d\n---\n"), Err(SkillError::InvalidName(n)) if n == "My Skill"));
    }

    #[test]
    fn clip_and_collapse() {
        assert_eq!(collapse("  a\n b\t\tc "), "a b c");
        assert_eq!(clip("abcdef", 10), "abcdef");
        assert_eq!(clip("abc defgh", 5), "abc…");
        assert_eq!(clip("äöüäöü", 4), "äöü…");
    }
}
