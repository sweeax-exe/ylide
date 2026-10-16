//! Reading and writing text files without surprising the user: binary files are
//! refused, BOM and line endings are preserved on write, writes are atomic.

use crate::{Result, Workspace, WorkspaceError};
use serde::{Deserialize, Serialize};
use std::fs;
use ts_rs::TS;

/// Default upper bound for files read into prompts or the editor.
pub const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TextFile {
    pub path: String,
    /// Content with the original line endings, without BOM.
    pub content: String,
    pub line_ending: LineEnding,
    pub has_bom: bool,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

pub fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf { LineEnding::Crlf } else { LineEnding::Lf }
}

/// Heuristic used by git: a NUL byte in the first 8 KiB means binary.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

impl Workspace {
    pub fn read_text(&self, rel: &str) -> Result<TextFile> {
        self.read_text_limited(rel, DEFAULT_MAX_BYTES)
    }

    pub fn read_text_limited(&self, rel: &str, limit: u64) -> Result<TextFile> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path).map_err(|_| WorkspaceError::NotFound(rel.to_string()))?;
        if meta.is_dir() {
            return Err(WorkspaceError::NotFound(rel.to_string()));
        }
        if meta.len() > limit {
            return Err(WorkspaceError::TooLarge {
                path: rel.to_string(),
                size: meta.len(),
                limit,
            });
        }
        let bytes = fs::read(&path)?;
        if looks_binary(&bytes) {
            return Err(WorkspaceError::Binary(rel.to_string()));
        }
        let has_bom = bytes.starts_with(BOM);
        let body = if has_bom { &bytes[3..] } else { &bytes[..] };
        let content = String::from_utf8_lossy(body).into_owned();
        Ok(TextFile {
            path: self.relative(&path).unwrap_or_else(|| rel.to_string()),
            line_ending: detect_line_ending(&content),
            content,
            has_bom,
            size_bytes: meta.len(),
        })
    }

    /// Writes `content` exactly as given (creates parent folders, atomic replace).
    pub fn write_text(&self, rel: &str, content: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_file_name(format!(
            ".{}.tmp-{}",
            path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            std::process::id()
        ));
        fs::write(&tmp, content.as_bytes())?;
        if let Err(e) = fs::rename(&tmp, &path) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(())
    }

    /// Writes model-produced text but keeps the file's existing BOM and line
    /// ending style, so agent edits do not cause whole-file diffs.
    pub fn write_text_preserving(&self, rel: &str, content: &str) -> Result<()> {
        let existing = self.read_text(rel).ok();
        let normalized = content.replace("\r\n", "\n");
        let (ending, bom) = match &existing {
            Some(f) => (f.line_ending, f.has_bom),
            None => (if cfg!(windows) && content.contains("\r\n") { LineEnding::Crlf } else { LineEnding::Lf }, false),
        };
        let mut out = String::with_capacity(normalized.len() + 3);
        if bom {
            out.push('\u{feff}');
        }
        match ending {
            LineEnding::Lf => out.push_str(&normalized),
            LineEnding::Crlf => out.push_str(&normalized.replace('\n', "\r\n")),
        }
        self.write_text(rel, &out)
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.resolve(rel).map(|p| p.exists()).unwrap_or(false)
    }

    /// Deletes a file or an (empty or non-empty) directory.
    pub fn delete(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path == self.root() {
            return Err(WorkspaceError::OutsideRoot(rel.to_string()));
        }
        let meta = fs::symlink_metadata(&path).map_err(|_| WorkspaceError::NotFound(rel.to_string()))?;
        if meta.is_dir() { fs::remove_dir_all(&path)? } else { fs::remove_file(&path)? }
        Ok(())
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(src, dst)?;
        Ok(())
    }

    pub fn create_dir(&self, rel: &str) -> Result<()> {
        fs::create_dir_all(self.resolve(rel)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::detect_line_ending;
    use crate::testutil::project;
    use crate::*;

    #[test]
    fn reads_text_and_detects_format() {
        let (ws, _) = project("read", &[("a.txt", "\u{feff}one\r\ntwo\r\n"), ("b.bin", "ab\0cd")]);
        let f = ws.read_text("a.txt").unwrap();
        assert!(f.has_bom);
        assert_eq!(f.line_ending, LineEnding::Crlf);
        assert_eq!(f.content, "one\r\ntwo\r\n");
        assert!(matches!(ws.read_text("b.bin"), Err(WorkspaceError::Binary(_))));
        assert!(matches!(ws.read_text("missing.txt"), Err(WorkspaceError::NotFound(_))));
    }

    #[test]
    fn enforces_size_limit() {
        let (ws, _) = project("limit", &[("big.txt", &"x".repeat(100))]);
        assert!(matches!(ws.read_text_limited("big.txt", 10), Err(WorkspaceError::TooLarge { .. })));
    }

    #[test]
    fn preserving_write_keeps_crlf_and_bom() {
        let (ws, dir) = project("preserve", &[("a.txt", "\u{feff}one\r\ntwo\r\n")]);
        ws.write_text_preserving("a.txt", "one\nTWO\nthree\n").unwrap();
        let bytes = std::fs::read(dir.join("a.txt")).unwrap();
        assert_eq!(bytes, "\u{feff}one\r\nTWO\r\nthree\r\n".as_bytes());
    }

    #[test]
    fn write_creates_folders_and_delete_removes() {
        let (ws, dir) = project("write", &[]);
        ws.write_text("deep/nested/file.rs", "fn x() {}").unwrap();
        assert!(dir.join("deep/nested/file.rs").exists());
        ws.delete("deep").unwrap();
        assert!(!dir.join("deep").exists());
        assert!(ws.delete("").is_err(), "the root itself can never be deleted");
    }

    #[test]
    fn line_ending_detection() {
        assert_eq!(detect_line_ending("a\nb\n"), LineEnding::Lf);
        assert_eq!(detect_line_ending("a\r\nb\r\n"), LineEnding::Crlf);
        assert_eq!(detect_line_ending("single line"), LineEnding::Lf);
    }
}
