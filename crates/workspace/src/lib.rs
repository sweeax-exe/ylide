//! Everything the editor and the agents need to work with a project folder.
//!
//! All paths that cross this API are *relative*, use forward slashes and are
//! resolved through [`Workspace::resolve`], which refuses anything outside the
//! project root, including escapes through `..` or symbolic links.

pub mod context;
pub mod search;
pub mod symbols;
pub mod text;
pub mod tree;

pub use context::{ContextItem, ContextKind, Mention, resolve_mentions};
pub use search::{FileMatch, SearchMatch, SearchQuery, SearchResults};
pub use symbols::{Symbol, SymbolKind};
pub use text::{LineEnding, TextFile};
pub use tree::{FileKind, FileNode};

use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("'{0}' is outside the project folder")]
    OutsideRoot(String),
    #[error("'{0}' does not exist")]
    NotFound(String),
    #[error("'{0}' is a binary file")]
    Binary(String),
    #[error("'{path}' is too large ({size} bytes, limit {limit})")]
    TooLarge { path: String, size: u64, limit: u64 },
    #[error("invalid search pattern: {0}")]
    Pattern(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, WorkspaceError>;

/// An opened project folder.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let root = dunce::canonicalize(path.as_ref())
            .map_err(|_| WorkspaceError::NotFound(path.as_ref().display().to_string()))?;
        if !root.is_dir() {
            return Err(WorkspaceError::NotFound(root.display().to_string()));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Display name of the project (folder name).
    pub fn name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// Resolves a project-relative path (or an absolute path inside the project)
    /// to an absolute path, refusing anything that would leave the root.
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        let trimmed = path.trim();
        check_path_syntax(trimmed).map_err(|_| WorkspaceError::OutsideRoot(path.to_string()))?;
        let candidate = Path::new(trimmed);
        let joined = if candidate.is_absolute() { candidate.to_path_buf() } else { self.root.join(candidate) };
        let normalized = normalize_lexically(&joined).ok_or_else(|| WorkspaceError::OutsideRoot(path.to_string()))?;
        if !starts_with_root(&normalized, &self.root) {
            return Err(WorkspaceError::OutsideRoot(path.to_string()));
        }
        // Use the root's spelling so later comparisons and `relative()` work.
        let normalized = match normalized.strip_prefix(&self.root) {
            Ok(_) => normalized,
            Err(_) => {
                let rest: PathBuf = normalized.components().skip(self.root.components().count()).collect();
                self.root.join(rest)
            }
        };
        // Symlinks: the real location of the nearest existing ancestor must be inside too.
        let mut probe = normalized.as_path();
        loop {
            if probe.exists() {
                let real = dunce::canonicalize(probe)?;
                if !real.starts_with(&self.root) {
                    return Err(WorkspaceError::OutsideRoot(path.to_string()));
                }
                break;
            }
            match probe.parent() {
                Some(p) => probe = p,
                None => break,
            }
        }
        Ok(normalized)
    }

    /// Forward-slash path relative to the root (`""` for the root itself).
    pub fn relative(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        Some(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
    }

    /// The given project-relative paths that name existing files, as
    /// forward-slash paths relative to the root (in the order given, without
    /// duplicates). Paths outside the project are skipped.
    pub fn existing_files(&self, paths: &[String]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for path in paths {
            let Ok(abs) = self.resolve(path) else { continue };
            if !abs.is_file() {
                continue;
            }
            if let Some(rel) = self.relative(&abs).filter(|r| !r.is_empty())
                && !out.contains(&rel)
            {
                out.push(rel);
            }
        }
        out
    }

    /// Paths the agent must never modify (VCS internals).
    pub fn is_protected(&self, rel: &str) -> bool {
        let rel = rel.replace('\\', "/");
        let first = rel.trim_start_matches("./").split('/').next().unwrap_or_default().to_string();
        matches!(first.as_str(), ".git" | ".hg" | ".svn")
    }
}

/// Files that usually hold credentials. Agents may see that they exist but not read them.
pub fn is_secret_path(rel: &str) -> bool {
    let rel = rel.replace('\\', "/").to_lowercase();
    let name = rel.rsplit('/').next().unwrap_or_default();
    let in_ssh_dir = rel.split('/').any(|c| c == ".ssh" || c == ".gnupg" || c == ".aws");
    let env_file = (name == ".env" || name.starts_with(".env."))
        && !matches!(name, ".env.example" | ".env.sample" | ".env.template" | ".env.dist");
    let key_file = name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || name == ".netrc"
        || name == ".npmrc"
        || name == ".pypirc"
        || name == "credentials.json";
    in_ssh_dir || env_file || key_file
}

/// Glob patterns that exclude secret files from searches (ripgrep override syntax).
pub const SECRET_GLOBS: &[&str] = &[
    "!.env",
    "!.env.*",
    "!*.pem",
    "!*.key",
    "!*.p12",
    "!*.pfx",
    "!id_rsa*",
    "!id_ed25519*",
    "!id_ecdsa*",
    "!.netrc",
    "!.npmrc",
    "!.pypirc",
    "!credentials.json",
    "!**/.ssh/**",
    "!**/.aws/**",
    "!**/.gnupg/**",
];

/// Rejects path forms that bypass normal resolution on Windows: UNC and device
/// paths (`\\server\share`, `\\?\`, `\\.\`), alternate data streams (`file:stream`)
/// and reserved device names (`CON`, `NUL`, `COM1`, ...). Applied on every OS so
/// that projects behave the same everywhere.
fn check_path_syntax(path: &str) -> std::result::Result<(), ()> {
    let unified = path.replace('\\', "/");
    if unified.starts_with("//") {
        return Err(());
    }
    for (i, part) in unified.split('/').enumerate() {
        let is_drive = i == 0 && part.len() == 2 && part.ends_with(':') && part.as_bytes()[0].is_ascii_alphabetic();
        if part.contains(':') && !is_drive {
            return Err(());
        }
        let stem = part.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit()
                && stem.as_bytes()[3] != b'0');
        if reserved {
            return Err(());
        }
    }
    Ok(())
}

/// `starts_with` that ignores case on case-insensitive file systems.
fn starts_with_root(path: &Path, root: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        let lower = |p: &Path| p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>();
        let (p, r) = (lower(path), lower(root));
        p.len() >= r.len() && p[..r.len()] == r[..]
    } else {
        path.starts_with(root)
    }
}

/// Resolves `.` and `..` without touching the file system. Returns `None` if
/// `..` would climb above the filesystem root.
fn normalize_lexically(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// Creates a fresh temporary project with the given files (unique per call,
    /// so tests running in parallel never share a folder).
    pub fn project(name: &str, files: &[(&str, &str)]) -> (super::Workspace, PathBuf) {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ws-test-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (path, content) in files {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
        (super::Workspace::open(&dir).unwrap(), dir)
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::project;
    use super::*;

    #[test]
    fn resolves_relative_and_absolute_inside_root() {
        let (ws, dir) = project("resolve", &[("src/main.rs", "fn main() {}")]);
        let p = ws.resolve("src/main.rs").unwrap();
        assert!(p.ends_with("main.rs"));
        let abs = dunce::canonicalize(dir.join("src/main.rs")).unwrap();
        assert_eq!(ws.resolve(&abs.display().to_string()).unwrap(), abs);
        assert_eq!(ws.relative(&p).unwrap(), "src/main.rs");
        assert!(ws.resolve("src/../src/new.rs").unwrap().ends_with("new.rs"));
    }

    #[test]
    fn existing_files_keeps_only_files_inside_the_project() {
        let (ws, _dir) = project("exists", &[("src/main.rs", "fn main() {}"), ("README.md", "# hi")]);
        let asked = ["src/main.rs", "./README.md", "src", "missing.rs", "../outside.rs", r"src\main.rs"].map(String::from);
        assert_eq!(ws.existing_files(&asked), vec!["src/main.rs".to_string(), "README.md".to_string()]);
    }

    #[test]
    fn refuses_escapes() {
        let (ws, _) = project("escape", &[("a.txt", "")]);
        assert!(matches!(ws.resolve("../outside.txt"), Err(WorkspaceError::OutsideRoot(_))));
        assert!(matches!(ws.resolve("src/../../x"), Err(WorkspaceError::OutsideRoot(_))));
        let other = std::env::temp_dir().display().to_string();
        assert!(ws.resolve(&other).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escape() {
        let (ws, dir) = project("symlink", &[("a.txt", "")]);
        std::os::unix::fs::symlink("/etc", dir.join("etc")).unwrap();
        assert!(ws.resolve("etc/passwd").is_err());
    }

    #[test]
    fn refuses_windows_path_tricks() {
        let (ws, _) = project("tricks", &[("a.txt", "")]);
        for bad in [
            r"\\server\share\x",
            r"\\?\C:\Windows\x",
            r"\\.\PhysicalDrive0",
            "//server/share",
            "a.txt:hidden",
            "src/file.rs:$DATA",
            "CON",
            "nul.txt",
            "logs/COM1.log",
            "LPT9",
        ] {
            assert!(ws.resolve(bad).is_err(), "{bad} must be rejected");
        }
        assert!(ws.resolve("com10.txt").is_ok());
        assert!(ws.resolve("console.log").is_ok());
        assert!(ws.resolve("src/null.rs").is_ok());
    }

    #[test]
    fn absolute_paths_ignore_case_on_windows() {
        if cfg!(windows) {
            let (ws, _) = project("case", &[("a.txt", "")]);
            let upper = ws.root().join("a.txt").display().to_string().to_uppercase();
            let resolved = ws.resolve(&upper).unwrap();
            assert_eq!(ws.relative(&resolved).unwrap().to_lowercase(), "a.txt");
        }
    }

    #[test]
    fn detects_secret_files() {
        for secret in [".env", ".env.local", "config/.env.production", "certs/server.pem", "id_rsa", "home/.ssh/config", ".npmrc", "keys/api.key"] {
            assert!(is_secret_path(secret), "{secret}");
        }
        for normal in [".env.example", "src/env.rs", "environment.ts", "README.md", "keyboard.rs", "monkey.txt"] {
            assert!(!is_secret_path(normal), "{normal}");
        }
    }

    #[test]
    fn protects_vcs_internals() {
        let (ws, _) = project("protected", &[]);
        assert!(ws.is_protected(".git/config"));
        assert!(ws.is_protected("./.git"));
        assert!(!ws.is_protected(".github/workflows/ci.yml"));
        assert!(!ws.is_protected("src/git.rs"));
    }
}
