//! Built-in tools with their JSON schemas, risk classes and implementations.
//!
//! Coordination tools (`finish`, `ask`, `submit_plan`, `submit_review`) are
//! declared here but handled by the runner, because they change the flow of
//! the run rather than the project.

use crate::checkpoints::CheckpointStore;
use crate::edit::{apply_edit, unified_diff};
use crate::permissions::ToolRisk;
use crate::protocol::{ChangeKind, FileChange};
use inference::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use workspace::{SearchQuery, Workspace};

pub const READ_FILE_MAX_LINES: usize = 600;
const LIST_MAX_ENTRIES: usize = 400;
const SEARCH_MAX_MATCHES: u32 = 100;

/// Looks at an image file of the project. Every role that uses tools gets
/// it while the model sees images (its vision projector is loaded).
pub const IMAGE_VIEW: &str = "image_view";

/// What `image_view` answers when the running model cannot see.
pub const NO_VISION: &str = "the model that is running cannot see images. Ask the user to describe the image, or to switch on image input on the Models page for a model that can see.";

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub risk: ToolRisk,
    pub description: &'static str,
    pub parameters: Value,
}

impl ToolSpec {
    pub fn definition(&self) -> ToolDefinition {
        ToolDefinition::function(self.name, self.description, self.parameters.clone())
    }
}

/// Reads enabled skills. No role lists it: every role that uses tools gets
/// it while skills are on (the Skills page is where they are switched).
pub const SKILL_READ: &str = "skill_read";

/// All tools known to the app. Roles pick a subset by name.
pub fn all_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_dir",
            risk: ToolRisk::Read,
            description: "List files and folders (respects .gitignore). Folders end with '/'.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Folder relative to the project root; empty for the root." },
                    "depth": { "type": "integer", "minimum": 1, "maximum": 4, "description": "How many levels to show (default 2)." }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "read_file",
            risk: ToolRisk::Read,
            description: "Read a text file. Long files are returned in parts; use start_line to continue.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "start_line": { "type": "integer", "minimum": 1 },
                    "end_line": { "type": "integer", "minimum": 1 }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: IMAGE_VIEW,
            risk: ToolRisk::Read,
            description: "Look at an image file of the project (PNG, JPEG, WebP, or the first frame of a GIF), e.g. a screenshot, mockup or diagram. You see the image with the result.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Image file relative to the project root." }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "search",
            risk: ToolRisk::Read,
            description: "Search the project for text (or a regex). Returns path:line: matches.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "regex": { "type": "boolean", "description": "Treat query as a regular expression." },
                    "glob": { "type": "string", "description": "Limit to files matching this glob, e.g. '*.rs'." }
                },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: "find_files",
            risk: ToolRisk::Read,
            description: "Find files by (fuzzy) name.",
            parameters: json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }),
        },
        ToolSpec {
            name: SKILL_READ,
            risk: ToolRisk::Read,
            description: "Read an enabled skill: its instructions (SKILL.md) or one of its files, e.g. references/guide.md. Long files come in parts; use start_line to continue.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The skill's name from the list of enabled skills." },
                    "file": { "type": "string", "description": "A file of the skill; leave out for SKILL.md." },
                    "start_line": { "type": "integer", "minimum": 1 }
                },
                "required": ["name"]
            }),
        },
        ToolSpec {
            name: "write_file",
            risk: ToolRisk::Write,
            description: "Create a new file or replace a file's entire content. Prefer edit_file for changes to existing files.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string", "description": "The complete new file content." }
                },
                "required": ["path", "content"]
            }),
        },
        ToolSpec {
            name: "edit_file",
            risk: ToolRisk::Write,
            description: "Replace an exact snippet in a file. old_text must be copied from the current file and match exactly one place; include a few surrounding lines to make it unique.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_text": { "type": "string", "description": "Exact existing text to replace." },
                    "new_text": { "type": "string", "description": "Replacement text (empty to delete)." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of exactly one." }
                },
                "required": ["path", "old_text", "new_text"]
            }),
        },
        ToolSpec {
            name: "delete_file",
            risk: ToolRisk::Delete,
            description: "Delete a file or folder.",
            parameters: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "run_command",
            risk: ToolRisk::Execute,
            description: "Run a non-interactive shell command in the project root (e.g. build or tests). Returns exit code and output.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 1800 }
                },
                "required": ["command"]
            }),
        },
        ToolSpec {
            name: "ask",
            risk: ToolRisk::Communicate,
            description: "Ask another agent or the user a question when you are blocked. Use sparingly.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "'orchestrator', 'reviewer', 'coder' or 'user'." },
                    "question": { "type": "string" }
                },
                "required": ["to", "question"]
            }),
        },
        ToolSpec {
            name: "finish",
            risk: ToolRisk::Communicate,
            description: "Call when the task is complete. Summarise what you changed and how it was verified.",
            parameters: json!({
                "type": "object",
                "properties": { "summary": { "type": "string" } },
                "required": ["summary"]
            }),
        },
        ToolSpec {
            name: "submit_plan",
            risk: ToolRisk::Communicate,
            description: "Submit the plan: a short approach and an ordered list of small, concrete tasks.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string" },
                    "tasks": {
                        "type": "array",
                        "maxItems": 12,
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "description": { "type": "string", "description": "What to do and how to verify it." },
                                "files": { "type": "array", "items": { "type": "string" } },
                                "assignee": { "type": "string", "description": "Role id, default 'coder'." }
                            },
                            "required": ["title", "description"]
                        }
                    }
                },
                "required": ["summary", "tasks"]
            }),
        },
        ToolSpec {
            name: "submit_review",
            risk: ToolRisk::Communicate,
            description: "Submit your review of the task's changes.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "verdict": { "type": "string", "enum": ["approve", "request_changes"] },
                    "summary": { "type": "string" },
                    "comments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": { "type": "string" },
                                "line": { "type": "integer" },
                                "severity": { "type": "string", "enum": ["blocker", "major", "minor", "nit"] },
                                "message": { "type": "string" }
                            },
                            "required": ["severity", "message"]
                        }
                    }
                },
                "required": ["verdict", "summary"]
            }),
        },
    ]
}

pub fn tool_spec(name: &str) -> Option<ToolSpec> {
    all_tools().into_iter().find(|t| t.name == name)
}

/// Argument names models commonly use instead of ours (Claude Code, OpenCode,
/// Aider and Cline conventions).
const ALIASES: &[(&str, &[&str])] = &[
    ("path", &["file_path", "filePath", "filename", "file", "dir", "directory"]),
    ("old_text", &["old_string", "old_str", "oldString", "oldText", "search"]),
    ("new_text", &["new_string", "new_str", "newString", "newText", "replace"]),
    ("content", &["contents", "text", "file_text", "code"]),
    ("command", &["cmd"]),
    ("query", &["pattern", "q", "search_query"]),
    ("timeout_seconds", &["timeout", "timeout_s"]),
    ("start_line", &["offset", "line_start"]),
    ("end_line", &["line_end"]),
    ("name", &["skill", "skill_name"]),
    ("file", &["path", "file_path", "filePath", "reference"]),
];

/// Repairs common argument mistakes before validation: renamed keys and
/// numbers or booleans sent as strings (the qwen3_coder XML format sends every
/// value as text).
pub fn normalize_arguments(spec: &ToolSpec, args: &mut Value) {
    let Some(obj) = args.as_object_mut() else { return };
    let props = spec.parameters["properties"].as_object().cloned().unwrap_or_default();
    for (canonical, aliases) in ALIASES {
        if !props.contains_key(*canonical) || obj.contains_key(*canonical) {
            continue;
        }
        if let Some(alias) = aliases.iter().find(|a| obj.contains_key(**a)) {
            let value = obj.remove(*alias).expect("checked");
            obj.insert(canonical.to_string(), value);
        }
    }
    for (key, schema) in &props {
        let Some(value) = obj.get_mut(key) else { continue };
        match (schema["type"].as_str(), &*value) {
            (Some("integer"), Value::String(s)) => {
                if let Ok(n) = s.trim().parse::<i64>() {
                    *value = Value::from(n);
                }
            }
            (Some("number"), Value::String(s)) => {
                if let Ok(n) = s.trim().parse::<f64>() {
                    *value = Value::from(n);
                }
            }
            (Some("boolean"), Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "1" => *value = Value::Bool(true),
                "false" | "no" | "0" => *value = Value::Bool(false),
                _ => {}
            },
            (Some("string"), Value::Number(n)) => *value = Value::String(n.to_string()),
            (Some("string"), Value::Bool(b)) => *value = Value::String(b.to_string()),
            (Some("array"), Value::String(s)) => {
                if let Ok(parsed @ Value::Array(_)) = serde_json::from_str::<Value>(s) {
                    *value = parsed;
                }
            }
            _ => {}
        }
    }
}

/// How `run_command` starts commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShellConfig {
    pub program: String,
    /// Arguments placed before the command string.
    pub args: Vec<String>,
    #[ts(type = "number")]
    pub default_timeout_secs: u64,
    pub max_output_chars: usize,
}

impl Default for ShellConfig {
    fn default() -> Self {
        if cfg!(windows) {
            Self {
                program: "powershell.exe".into(),
                args: vec!["-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into()],
                default_timeout_secs: 120,
                max_output_chars: 20_000,
            }
        } else {
            Self {
                program: "sh".into(),
                args: vec!["-c".into()],
                default_timeout_secs: 120,
                max_output_chars: 20_000,
            }
        }
    }
}

impl ShellConfig {
    /// Lower-case program name without directory and extension ("powershell", "pwsh", "cmd", "sh").
    pub fn program_stem(&self) -> String {
        let name = self.program.rsplit(['/', '\\']).next().unwrap_or_default();
        std::path::Path::new(name).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
    }

    /// Windows PowerShell 5.1 (`powershell.exe`), which unlike pwsh 7 has no `&&` and `||`.
    pub fn is_windows_powershell(&self) -> bool {
        self.program_stem() == "powershell"
    }
}

/// Context for executing project tools.
pub struct ToolEnv<'a> {
    pub ws: &'a Workspace,
    pub checkpoints: &'a CheckpointStore,
    pub run_id: &'a str,
    pub checkpoint_id: &'a str,
    pub shell: &'a ShellConfig,
    pub cancel: &'a CancellationToken,
    /// Files read during this run; existing files must be read before `write_file` replaces them.
    pub read_files: &'a std::sync::Mutex<std::collections::HashSet<String>>,
    /// The skills `skill_read` may read.
    pub skills: &'a [skills::EnabledSkill],
    /// Characters `skill_read` returns at once (see `skills::prompt::read_budget`).
    pub skill_chars: usize,
}

fn canonical_rel(env: &ToolEnv<'_>, path: &str) -> String {
    env.ws.resolve(path).ok().and_then(|abs| env.ws.relative(&abs)).unwrap_or_else(|| path.to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    /// Text returned to the model.
    pub output: String,
    pub ok: bool,
    /// One-line summary for the UI.
    pub summary: String,
    pub change: Option<FileChange>,
    /// Images returned to the model with the text (data URLs, `image_view`).
    pub images: Vec<String>,
}

impl ToolOutcome {
    fn ok(output: String, summary: String) -> Self {
        Self {
            output,
            ok: true,
            summary,
            change: None,
            images: Vec::new(),
        }
    }
    fn err(message: impl ToString) -> Self {
        let m = message.to_string();
        Self {
            output: format!("Error: {m}"),
            ok: false,
            summary: m,
            change: None,
            images: Vec::new(),
        }
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// Short human description of a call for status lines and approval dialogs.
pub fn describe_call(name: &str, args: &Value) -> String {
    let path = arg_str(args, "path").unwrap_or_default();
    match name {
        "read_file" | "write_file" | "edit_file" | "delete_file" | "list_dir" | IMAGE_VIEW => format!("{name} {path}").trim().to_string(),
        "search" | "find_files" => format!("{name} \"{}\"", arg_str(args, "query").unwrap_or_default()),
        "run_command" => format!("run `{}`", arg_str(args, "command").unwrap_or_default()),
        "ask" => format!("ask {}", arg_str(args, "to").unwrap_or_default()),
        SKILL_READ => format!("{SKILL_READ} {} {}", arg_str(args, "name").unwrap_or_default(), arg_str(args, "file").unwrap_or_default()).trim().to_string(),
        other => other.to_string(),
    }
}

/// Executes a project tool. Never panics; problems become error outputs the
/// model can react to.
pub async fn execute(name: &str, args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    match name {
        "list_dir" => list_dir(args, env),
        "read_file" => read_file(args, env),
        IMAGE_VIEW => image_view(args, env),
        "search" => search(args, env),
        "find_files" => {
            let q = arg_str(args, "query").unwrap_or_default();
            let files = env.ws.find_files(q, 50);
            let summary = format!("{} files", files.len());
            ToolOutcome::ok(if files.is_empty() { "No files found.".into() } else { files.join("\n") }, summary)
        }
        "write_file" => write_file(args, env),
        "edit_file" => edit_file(args, env),
        "delete_file" => delete_file(args, env),
        "run_command" => run_command(args, env).await,
        SKILL_READ => skill_read(args, env),
        other => ToolOutcome::err(format!("unknown tool '{other}'")),
    }
}

fn skill_read(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let name = match require(args, "name") {
        Ok(n) => n,
        Err(e) => return e,
    };
    let file = arg_str(args, "file");
    if let Some(f) = file.filter(|f| workspace::is_secret_path(f)) {
        return ToolOutcome::err(format!("'{f}' looks like a credentials file; agents are not allowed to read it"));
    }
    let start = args.get("start_line").and_then(Value::as_u64).unwrap_or(1) as usize;
    match skills::prompt::read(env.skills, name, file, start, env.skill_chars) {
        Ok(text) => {
            let summary = format!("skill {name}: {}", file.filter(|f| !f.trim().is_empty()).unwrap_or("SKILL.md"));
            ToolOutcome::ok(text, summary)
        }
        Err(e) => ToolOutcome::err(e),
    }
}

// The error *is* the tool's answer to the model, so it carries a full outcome.
#[allow(clippy::result_large_err)]
fn require<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolOutcome> {
    arg_str(args, key).ok_or_else(|| ToolOutcome::err(format!("missing required argument '{key}'")))
}

fn list_dir(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let path = arg_str(args, "path").unwrap_or_default().trim_matches('/');
    let depth = args.get("depth").and_then(Value::as_u64).unwrap_or(2).clamp(1, 4) as usize;
    match env.ws.outline(path, depth, LIST_MAX_ENTRIES) {
        Ok(o) if o.is_empty() => ToolOutcome::ok("(empty folder)".into(), format!("{path}/ is empty")),
        Ok(o) => {
            let n = o.lines().count();
            ToolOutcome::ok(o, format!("{n} entries"))
        }
        Err(e) => ToolOutcome::err(e),
    }
}

fn read_file(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let path = match require(args, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    if workspace::is_secret_path(path) {
        return ToolOutcome::err(format!("'{path}' looks like a credentials file; agents are not allowed to read it"));
    }
    let file = match env.ws.read_text(path) {
        Ok(f) => f,
        // Seen with a real model: it reads a screenshot as text first.
        Err(e) if is_image_path(path) => return ToolOutcome::err(format!("{e}: it is an image. A model that sees images can look at it with {IMAGE_VIEW}")),
        Err(e) => return ToolOutcome::err(e),
    };
    env.read_files.lock().unwrap_or_else(|e| e.into_inner()).insert(canonical_rel(env, path));
    let lines: Vec<&str> = file.content.lines().collect();
    let total = lines.len();
    let start = args.get("start_line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
    let requested_end = args.get("end_line").and_then(Value::as_u64).map(|e| e as usize).unwrap_or(total);
    let end = requested_end.min(total).min(start + READ_FILE_MAX_LINES - 1);
    if total == 0 {
        return ToolOutcome::ok(format!("File {path} is empty."), format!("{path} (empty)"));
    }
    if start > total {
        return ToolOutcome::err(format!("start_line {start} is beyond the end of {path} ({total} lines)"));
    }
    let body = lines[start - 1..end].join("\n");
    let mut out = format!("File {} (lines {start}-{end} of {total}):\n{body}", file.path);
    if end < requested_end.min(total) || (end < total && args.get("end_line").is_none()) {
        out.push_str(&format!("\n[{} more lines; call read_file with start_line={} to continue]", total - end, end + 1));
    }
    ToolOutcome::ok(out, format!("{} ({}-{} of {total})", file.path, start, end))
}

/// Image files `image_view` shows, by their extension.
fn is_image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif"].iter().any(|ext| lower.ends_with(ext))
}

/// The image goes to the model as it is; llama.cpp decodes and scales it.
fn image_view(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    use inference::image::{MAX_IMAGE_BYTES, data_url, image_info};
    let path = match require(args, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    if workspace::is_secret_path(path) {
        return ToolOutcome::err(format!("'{path}' looks like a credentials file; agents are not allowed to read it"));
    }
    let abs = match env.ws.resolve(path) {
        Ok(a) => a,
        Err(e) => return ToolOutcome::err(e),
    };
    let rel = env.ws.relative(&abs).unwrap_or_else(|| path.to_string());
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => return ToolOutcome::err(format!("'{rel}' is a folder")),
        Ok(m) if m.len() > MAX_IMAGE_BYTES as u64 => return ToolOutcome::err(format!("'{rel}' is larger than {} MB", MAX_IMAGE_BYTES >> 20)),
        Ok(_) => {}
        Err(_) => return ToolOutcome::err(format!("'{rel}' does not exist")),
    }
    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => return ToolOutcome::err(format!("could not read '{rel}': {e}")),
    };
    let info = match image_info(&bytes) {
        Ok(i) => i,
        Err(e) => return ToolOutcome::err(format!("'{rel}': {e}")),
    };
    let size = format!("{}x{} {}", info.width, info.height, info.format.name());
    ToolOutcome {
        output: format!("Image {rel} ({size}, {} KB):", bytes.len().div_ceil(1024)),
        ok: true,
        summary: format!("{rel} ({size})"),
        change: None,
        images: vec![data_url(info.format, &bytes)],
    }
}

fn search(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let query = match require(args, "query") {
        Ok(q) => q,
        Err(e) => return e,
    };
    let mut q = SearchQuery::literal(query);
    q.regex = args.get("regex").and_then(Value::as_bool).unwrap_or(false);
    q.max_results = SEARCH_MAX_MATCHES;
    if let Some(g) = arg_str(args, "glob").filter(|g| !g.is_empty()) {
        q.globs = vec![g.to_string()];
    }
    q.globs.extend(workspace::SECRET_GLOBS.iter().map(|g| g.to_string()));
    match env.ws.search(&q) {
        Ok(r) if r.files.is_empty() => ToolOutcome::ok("No matches.".into(), "0 matches".into()),
        Ok(r) => {
            let mut out = String::new();
            for f in &r.files {
                for m in &f.matches {
                    out.push_str(&format!("{}:{}: {}\n", f.path, m.line_number, m.line.trim()));
                }
            }
            if r.truncated {
                out.push_str(&format!("[stopped after {SEARCH_MAX_MATCHES} matches; refine the query]\n"));
            }
            ToolOutcome::ok(out, format!("{} matches in {} files", r.total_matches, r.files.len()))
        }
        Err(e) => ToolOutcome::err(e),
    }
}

fn protect(env: &ToolEnv<'_>, path: &str) -> Option<ToolOutcome> {
    if env.ws.is_protected(path) {
        return Some(ToolOutcome::err(format!("'{path}' is protected and cannot be modified by agents")));
    }
    if let Err(e) = env.ws.resolve(path) {
        return Some(ToolOutcome::err(e));
    }
    None
}

fn record_change(env: &ToolEnv<'_>, path: &str, before: Option<&str>, after: Option<&str>) -> FileChange {
    let kind = match (before, after) {
        (None, Some(_)) => ChangeKind::Created,
        (Some(_), None) => ChangeKind::Deleted,
        _ => ChangeKind::Modified,
    };
    FileChange {
        path: path.to_string(),
        kind,
        diff: unified_diff(path, before.unwrap_or_default(), after.unwrap_or_default()),
        checkpoint_id: env.checkpoint_id.to_string(),
    }
}

#[allow(clippy::result_large_err)]
fn snapshot(env: &ToolEnv<'_>, path: &str) -> Result<(), ToolOutcome> {
    env.checkpoints
        .snapshot_before(env.run_id, env.checkpoint_id, env.ws, path)
        .map_err(|e| ToolOutcome::err(format!("could not create checkpoint: {e}")))
}

fn write_file(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let (path, content) = match (require(args, "path"), require(args, "content")) {
        (Ok(p), Ok(c)) => (p, c),
        (Err(e), _) | (_, Err(e)) => return e,
    };
    if let Some(e) = protect(env, path) {
        return e;
    }
    let before = env.ws.read_text(path).ok().map(|f| f.content);
    if env.ws.exists(path) && before.is_none() {
        return ToolOutcome::err(format!("'{path}' exists but is not a text file; refusing to overwrite"));
    }
    if before.is_some() && !env.read_files.lock().unwrap_or_else(|e| e.into_inner()).contains(&canonical_rel(env, path)) {
        return ToolOutcome::err(format!(
            "'{path}' already exists. Read it with read_file first, then prefer edit_file for changes"
        ));
    }
    if workspace::is_secret_path(path) {
        return ToolOutcome::err(format!("'{path}' looks like a credentials file; agents may not write it"));
    }
    if let Err(e) = snapshot(env, path) {
        return e;
    }
    if let Err(e) = env.ws.write_text_preserving(path, content) {
        return ToolOutcome::err(e);
    }
    let after = env.ws.read_text(path).map(|f| f.content).unwrap_or_else(|_| content.to_string());
    let change = record_change(env, path, before.as_deref(), Some(&after));
    let (added, removed) = crate::edit::diff_stats(before.as_deref().unwrap_or_default(), &after);
    let verb = if before.is_some() { "Updated" } else { "Created" };
    ToolOutcome {
        output: format!("{verb} {path} (+{added} -{removed} lines)."),
        ok: true,
        summary: format!("{verb} {path} (+{added} -{removed})"),
        change: Some(change),
        images: Vec::new(),
    }
}

fn edit_file(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let (path, old_text, new_text) = match (require(args, "path"), require(args, "old_text"), require(args, "new_text")) {
        (Ok(p), Ok(o), Ok(n)) => (p, o, n),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
    };
    if let Some(e) = protect(env, path) {
        return e;
    }
    if workspace::is_secret_path(path) {
        return ToolOutcome::err(format!("'{path}' looks like a credentials file; agents may not edit it"));
    }
    let replace_all = args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
    let before = match env.ws.read_text(path) {
        Ok(f) => f.content,
        Err(e) => return ToolOutcome::err(format!("{e}. Use write_file to create new files.")),
    };
    let after = match apply_edit(&before, old_text, new_text, replace_all) {
        Ok(a) => a,
        Err(e) => return ToolOutcome::err(format!("edit of {path} failed: {e}")),
    };
    if let Err(e) = snapshot(env, path) {
        return e;
    }
    if let Err(e) = env.ws.write_text(path, &after) {
        return ToolOutcome::err(e);
    }
    let (added, removed) = crate::edit::diff_stats(&before, &after);
    let change = record_change(env, path, Some(&before), Some(&after));
    ToolOutcome {
        output: format!("Edited {path} (+{added} -{removed} lines).\n{}", change.diff),
        ok: true,
        summary: format!("Edited {path} (+{added} -{removed})"),
        change: Some(change),
        images: Vec::new(),
    }
}

fn delete_file(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    let path = match require(args, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    if let Some(e) = protect(env, path) {
        return e;
    }
    if path.trim().trim_matches('/').is_empty() || path.trim() == "." {
        return ToolOutcome::err("refusing to delete the project root");
    }
    let abs = match env.ws.resolve(path) {
        Ok(a) => a,
        Err(e) => return ToolOutcome::err(e),
    };
    if abs.is_dir() {
        // Snapshot every file inside so the folder can be restored.
        for f in env.ws.list_files(path, 10_000).unwrap_or_default() {
            if let Err(e) = snapshot(env, &f) {
                return e;
            }
        }
    } else if let Err(e) = snapshot(env, path) {
        return e;
    }
    let before = env.ws.read_text(path).ok().map(|f| f.content);
    if let Err(e) = env.ws.delete(path) {
        return ToolOutcome::err(e);
    }
    ToolOutcome {
        output: format!("Deleted {path}."),
        ok: true,
        summary: format!("Deleted {path}"),
        change: Some(record_change(env, path, Some(before.as_deref().unwrap_or_default()), None)),
        images: Vec::new(),
    }
}

/// Removes ANSI escape sequences from command output.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Keeps head and tail of long output.
pub fn truncate_middle(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let half = max / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(count - half).collect();
    format!("{head}\n[... {} characters omitted ...]\n{tail}", count - max)
}

/// Local models often chain with `&&`, which Windows PowerShell 5.1 rejects with
/// a parser error. Only a hint is added to the output: the command itself is
/// never rewritten, because the user approved exactly that text. The operator
/// alone is not enough, as it may sit in a quoted argument of a command that
/// failed for another reason; unlike the message, the parser error id is not
/// localized.
fn chain_operator_hint(shell: &ShellConfig, command: &str, output: &str) -> Option<&'static str> {
    (shell.is_windows_powershell()
        && (command.contains("&&") || command.contains("||"))
        && (output.contains("InvalidEndOfLine") || marks_chain_operator(output)))
    .then_some(
        "Hint: Windows PowerShell 5.1 has no && or || operators. Chain commands with ; or use separate run_command calls; commands already start in the project root, so use project-relative paths instead of cd.",
    )
}

/// Windows PowerShell prints every parser error with the source line ("+ cmd")
/// and a marker line under the bad token ("+      ~~"). With several errors
/// only the first one's id is printed, so `InvalidEndOfLine` alone misses an
/// `&&` that comes after another error; the marker does not.
fn marks_chain_operator(output: &str) -> bool {
    let lines: Vec<&str> = output.lines().map(|l| l.trim_end_matches('\r')).collect();
    lines.windows(2).any(|pair| {
        let (source, marker) = (pair[0], pair[1]);
        let Some(column) = marker.find('~') else { return false };
        source.starts_with("+ ")
            && marker.starts_with('+')
            && marker[1..column].chars().all(|c| c == ' ')
            && matches!(source.chars().skip(column).take(2).collect::<String>().as_str(), "&&" | "||")
    })
}

async fn run_command(args: &Value, env: &ToolEnv<'_>) -> ToolOutcome {
    use process_wrap::tokio::*;
    let command = match require(args, "command") {
        Ok(c) => c.to_string(),
        Err(e) => return e,
    };
    let timeout = Duration::from_secs(
        args.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(env.shell.default_timeout_secs).clamp(1, 1800),
    );
    let mut wrap = CommandWrap::with_new(&env.shell.program, |c| {
        c.args(&env.shell.args)
            .arg(&command)
            .current_dir(env.ws.root())
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    });
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        wrap.wrap(CreationFlags(CREATE_NO_WINDOW));
        wrap.wrap(JobObject);
    }
    #[cfg(unix)]
    wrap.wrap(ProcessGroup::leader());
    wrap.wrap(KillOnDrop);

    let mut child = match wrap.spawn() {
        Ok(c) => c,
        Err(e) => return ToolOutcome::err(format!("could not start shell '{}': {e}", env.shell.program)),
    };
    let mut stdout = child.stdout().take();
    let mut stderr = child.stderr().take();
    let read_out = async move {
        let mut s = Vec::new();
        if let Some(o) = stdout.as_mut() {
            let _ = o.read_to_end(&mut s).await;
        }
        s
    };
    let read_err = async move {
        let mut s = Vec::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_end(&mut s).await;
        }
        s
    };
    let started = std::time::Instant::now();
    let result = tokio::select! {
        _ = env.cancel.cancelled() => None,
        _ = tokio::time::sleep(timeout) => Some(None),
        r = async { let (o, e) = tokio::join!(read_out, read_err); (o, e, child.wait().await) } => Some(Some(r)),
    };
    let (out, err, status) = match result {
        None => return ToolOutcome::err("command cancelled"),
        Some(None) => {
            // `child` is dropped with KillOnDrop/JobObject: the whole process tree dies.
            return ToolOutcome::err(format!("command timed out after {}s and was stopped", timeout.as_secs()));
        }
        Some(Some(r)) => r,
    };
    let code = status.ok().and_then(|s| s.code());
    let stdout = strip_ansi(&String::from_utf8_lossy(&out));
    let stderr = strip_ansi(&String::from_utf8_lossy(&err));
    let mut text = format!("Exit code: {}\n", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()));
    if !stdout.trim().is_empty() {
        text.push_str(&format!("stdout:\n{}\n", stdout.trim_end()));
    }
    if !stderr.trim().is_empty() {
        text.push_str(&format!("stderr:\n{}\n", stderr.trim_end()));
    }
    let ok = code == Some(0);
    let mut output = truncate_middle(&text, env.shell.max_output_chars);
    // `text` is stdout plus stderr before truncation; PowerShell prints parser errors on stderr.
    if !ok && let Some(hint) = chain_operator_hint(env.shell, &command, &text) {
        output.push_str(hint);
        output.push('\n');
    }
    let secs = started.elapsed().as_secs_f32();
    ToolOutcome {
        ok,
        summary: format!("`{}` exited with {} after {secs:.1}s", crate::protocol::first_line(&command, 60), code.unwrap_or(-1)),
        output,
        change: None,
        images: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn setup(name: &str) -> (Workspace, PathBuf, CheckpointStore) {
        let base = std::env::temp_dir().join(format!("tools-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let proj = base.join("p");
        std::fs::create_dir_all(proj.join("src")).unwrap();
        std::fs::write(proj.join("src/main.rs"), "fn main() {\n    println!(\"hi\");\n}\n").unwrap();
        std::fs::create_dir_all(proj.join(".git")).unwrap();
        std::fs::write(proj.join(".git/config"), "x").unwrap();
        (Workspace::open(&proj).unwrap(), proj, CheckpointStore::new(base.join("cp")))
    }

    async fn run(name: &str, args: Value, ws: &Workspace, cp: &CheckpointStore) -> ToolOutcome {
        run_with(name, args, ws, cp, &std::sync::Mutex::default()).await
    }

    async fn run_with(
        name: &str,
        args: Value,
        ws: &Workspace,
        cp: &CheckpointStore,
        read_files: &std::sync::Mutex<std::collections::HashSet<String>>,
    ) -> ToolOutcome {
        let checkpoint = cp.begin("run", "test").unwrap();
        let shell = ShellConfig::default();
        let cancel = CancellationToken::new();
        let env = ToolEnv {
            ws,
            checkpoints: cp,
            run_id: "run",
            checkpoint_id: &checkpoint.id,
            shell: &shell,
            cancel: &cancel,
            read_files,
            skills: &[],
            skill_chars: 12_000,
        };
        execute(name, &args, &env).await
    }

    #[tokio::test]
    async fn skills_are_read_through_their_tool() {
        let (ws, proj, cp) = setup("skills");
        let dir = proj.parent().unwrap().join("skills/pdf");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: pdf\ndescription: Fill forms.\n---\n# PDF\nRead references/forms.md first.\n").unwrap();
        std::fs::write(dir.join("references/forms.md"), "Use qpdf.\n").unwrap();
        let skills = vec![skills::EnabledSkill { name: "pdf".into(), description: "Fill forms.".into(), dir }];
        let checkpoint = cp.begin("run", "test").unwrap();
        let (shell, cancel, read) = (ShellConfig::default(), CancellationToken::new(), std::sync::Mutex::default());
        let env = ToolEnv { ws: &ws, checkpoints: &cp, run_id: "run", checkpoint_id: &checkpoint.id, shell: &shell, cancel: &cancel, read_files: &read, skills: &skills, skill_chars: 12_000 };

        let r = execute(SKILL_READ, &json!({"name": "pdf"}), &env).await;
        assert!(r.ok && r.output.contains("# PDF\nRead references/forms.md first.") && r.output.contains("references/forms.md"), "{}", r.output);
        assert_eq!(r.summary, "skill pdf: SKILL.md");
        let mut args = json!({"skill": "pdf", "path": "references/forms.md"});
        normalize_arguments(&tool_spec(SKILL_READ).unwrap(), &mut args);
        assert_eq!(args, json!({"name": "pdf", "file": "references/forms.md"}));
        let r = execute(SKILL_READ, &args, &env).await;
        assert!(r.ok && r.output.ends_with("Use qpdf."), "{}", r.output);
        assert_eq!(describe_call(SKILL_READ, &args), "skill_read pdf references/forms.md");
        let r = execute(SKILL_READ, &json!({"name": "pdf", "file": "../../p/src/main.rs"}), &env).await;
        assert!(!r.ok && r.output.starts_with("Error: "), "{}", r.output);
        let r = execute(SKILL_READ, &json!({"name": "pdf", "file": "references/.env"}), &env).await;
        assert!(!r.ok && r.output.contains("credentials"), "{}", r.output);
        let r = execute(SKILL_READ, &json!({"file": "x"}), &env).await;
        assert_eq!(r.output, "Error: missing required argument 'name'");
    }

    #[tokio::test]
    async fn existing_files_must_be_read_before_overwrite() {
        let (ws, _, cp) = setup("readfirst");
        let read = std::sync::Mutex::default();
        let r = run_with("write_file", json!({"path": "src/main.rs", "content": "x"}), &ws, &cp, &read).await;
        assert!(!r.ok && r.output.contains("Read it with read_file first"), "{}", r.output);
        assert!(run_with("read_file", json!({"path": "src/main.rs"}), &ws, &cp, &read).await.ok);
        let r = run_with("write_file", json!({"path": "src/main.rs", "content": "fn main() {}\n"}), &ws, &cp, &read).await;
        assert!(r.ok, "{}", r.output);
    }

    #[tokio::test]
    async fn secrets_are_off_limits() {
        let (ws, proj, cp) = setup("secrets");
        std::fs::write(proj.join(".env"), "API_KEY=supersecret").unwrap();
        let r = run("read_file", json!({"path": ".env"}), &ws, &cp).await;
        assert!(!r.ok && r.output.contains("credentials"));
        let r = run("search", json!({"query": "supersecret"}), &ws, &cp).await;
        assert!(!r.output.contains("supersecret"), "{}", r.output);
        assert!(!run("edit_file", json!({"path": ".env", "old_text": "API_KEY", "new_text": "X"}), &ws, &cp).await.ok);
    }

    #[test]
    fn arguments_are_normalized() {
        let spec = tool_spec("edit_file").unwrap();
        let mut args = json!({"file_path": "a.rs", "old_str": "x", "new_str": "y", "replace_all": "true"});
        normalize_arguments(&spec, &mut args);
        assert_eq!(args, json!({"path": "a.rs", "old_text": "x", "new_text": "y", "replace_all": true}));
        let spec = tool_spec("read_file").unwrap();
        let mut args = json!({"path": "a.rs", "start_line": "10", "end_line": 20});
        normalize_arguments(&spec, &mut args);
        assert_eq!(args["start_line"], 10);
        let spec = tool_spec("run_command").unwrap();
        let mut args = json!({"cmd": "cargo test", "timeout": "30"});
        normalize_arguments(&spec, &mut args);
        assert_eq!(args, json!({"command": "cargo test", "timeout_seconds": 30}));
    }

    #[tokio::test]
    async fn read_list_search() {
        let (ws, _, cp) = setup("read");
        let r = run("read_file", json!({"path": "src/main.rs"}), &ws, &cp).await;
        assert!(r.ok);
        assert!(r.output.starts_with("File src/main.rs (lines 1-3 of 3):\nfn main()"));
        let r = run("read_file", json!({"path": "src/main.rs", "start_line": 2, "end_line": 2}), &ws, &cp).await;
        assert!(r.output.ends_with("println!(\"hi\");"), "{}", r.output);
        let r = run("list_dir", json!({"path": ""}), &ws, &cp).await;
        assert!(r.output.contains("src/") && r.output.contains("main.rs") && !r.output.contains(".git"));
        let r = run("search", json!({"query": "println"}), &ws, &cp).await;
        assert!(r.output.contains("src/main.rs:2:"));
        let r = run("read_file", json!({"path": "../../etc/passwd"}), &ws, &cp).await;
        assert!(!r.ok);
    }

    #[tokio::test]
    async fn images_are_shown_to_the_model() {
        let (ws, proj, cp) = setup("image");
        // A PNG header is enough for the format and the size; llama.cpp reads the rest.
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend(1280u32.to_be_bytes());
        png.extend(720u32.to_be_bytes());
        png.extend([8, 6, 0, 0, 0]);
        std::fs::create_dir_all(proj.join("docs")).unwrap();
        std::fs::write(proj.join("docs/screen.png"), &png).unwrap();
        let r = run(IMAGE_VIEW, json!({"path": "docs/screen.png"}), &ws, &cp).await;
        assert!(r.ok, "{}", r.output);
        assert_eq!(r.output, "Image docs/screen.png (1280x720 PNG, 1 KB):");
        assert_eq!(r.summary, "docs/screen.png (1280x720 PNG)");
        assert_eq!(r.images, vec![inference::image::data_url(inference::image::ImageFormat::Png, &png)]);
        assert_eq!(describe_call(IMAGE_VIEW, &json!({"path": "docs/screen.png"})), "image_view docs/screen.png");

        // Not an image, not there, outside the project, a folder.
        let r = run(IMAGE_VIEW, json!({"path": "src/main.rs"}), &ws, &cp).await;
        assert!(!r.ok && r.output.contains("not a PNG, JPEG, GIF or WebP image") && r.images.is_empty(), "{}", r.output);
        assert!(run(IMAGE_VIEW, json!({"path": "docs/missing.png"}), &ws, &cp).await.output.contains("does not exist"));
        assert!(!run(IMAGE_VIEW, json!({"path": "../outside.png"}), &ws, &cp).await.ok);
        assert!(run(IMAGE_VIEW, json!({"path": "docs"}), &ws, &cp).await.output.contains("is a folder"));
        let mut args = json!({"file_path": "docs/screen.png"});
        normalize_arguments(&tool_spec(IMAGE_VIEW).unwrap(), &mut args);
        assert_eq!(args, json!({"path": "docs/screen.png"}));
        // read_file on an image points to image_view.
        let r = run("read_file", json!({"path": "docs/screen.png"}), &ws, &cp).await;
        assert!(!r.ok && r.output.ends_with("it is an image. A model that sees images can look at it with image_view"), "{}", r.output);
    }

    #[tokio::test]
    async fn write_edit_delete_produce_changes_and_checkpoints() {
        let (ws, proj, cp) = setup("write");
        let r = run("write_file", json!({"path": "src/new.rs", "content": "pub fn x() {}\n"}), &ws, &cp).await;
        // creating a new file needs no prior read
        assert!(r.ok, "{}", r.output);
        assert_eq!(r.change.as_ref().unwrap().kind, ChangeKind::Created);
        let r = run("edit_file", json!({"path": "src/main.rs", "old_text": "println!(\"hi\");", "new_text": "println!(\"hello\");"}), &ws, &cp).await;
        assert!(r.ok, "{}", r.output);
        assert!(r.change.as_ref().unwrap().diff.contains("+    println!(\"hello\");"));
        assert!(std::fs::read_to_string(proj.join("src/main.rs")).unwrap().contains("hello"));
        let r = run("edit_file", json!({"path": "src/main.rs", "old_text": "does not exist", "new_text": "x"}), &ws, &cp).await;
        assert!(!r.ok && r.output.contains("not found"));
        let r = run("delete_file", json!({"path": "src/new.rs"}), &ws, &cp).await;
        assert!(r.ok);
        assert!(!proj.join("src/new.rs").exists());
    }

    #[tokio::test]
    async fn refuses_protected_and_root_paths() {
        let (ws, _, cp) = setup("protect");
        assert!(!run("write_file", json!({"path": ".git/config", "content": "evil"}), &ws, &cp).await.ok);
        assert!(!run("delete_file", json!({"path": ""}), &ws, &cp).await.ok);
        assert!(!run("delete_file", json!({"path": "."}), &ws, &cp).await.ok);
        assert!(!run("write_file", json!({"path": "../x.txt", "content": "x"}), &ws, &cp).await.ok);
    }

    #[tokio::test]
    async fn runs_commands_with_exit_codes_and_timeouts() {
        let (ws, _, cp) = setup("cmd");
        let r = run("run_command", json!({"command": "echo ylide-test"}), &ws, &cp).await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("Exit code: 0") && r.output.contains("ylide-test"));
        let r = run("run_command", json!({"command": "exit 3"}), &ws, &cp).await;
        assert!(!r.ok && r.output.contains("Exit code: 3"), "{}", r.output);
        let sleep = if cfg!(windows) { "Start-Sleep -Seconds 30" } else { "sleep 30" };
        let started = std::time::Instant::now();
        let r = run("run_command", json!({"command": sleep, "timeout_seconds": 1}), &ws, &cp).await;
        assert!(!r.ok && r.output.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn chain_operator_hint_only_for_windows_powershell() {
        let shell = |program: &str| ShellConfig { program: program.into(), ..ShellConfig::default() };
        let ps = shell("powershell.exe");
        // stderr of a German Windows PowerShell 5.1: only the error id is not localized
        let parser_error = "Exit code: 1\nstderr:\nIn Zeile:1 Zeichen:8\n+ cd test && node --test cart.test.js\n\
            Das Token \"&&\" ist in dieser Version kein gültiges Anweisungstrennzeichen.\n\
            + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n\
            + FullyQualifiedErrorId : InvalidEndOfLine\n";
        assert!(chain_operator_hint(&ps, "cd test && node --test cart.test.js", parser_error).is_some());
        assert!(
            chain_operator_hint(
                &shell(r"C:\Windows\System32\WindowsPowerShell\v1.0\PowerShell.exe"),
                "a || b",
                parser_error
            )
            .is_some()
        );
        assert!(chain_operator_hint(&ps, "node --test test/cart.test.js", parser_error).is_none());
        // Several parser errors: only the first id is printed, the marker still points at ||.
        let multi = "In Zeile:1 Zeichen:2\r\n+ [ -d node_modules ] || npm install\r\n+  ~\r\n\
            Der Typname nach \"[\" fehlt.\r\nIn Zeile:1 Zeichen:21\r\n+ [ -d node_modules ] || npm install\r\n\
            +                     ~~\r\nDas Token \"||\" ist in dieser Version kein gültiges Anweisungstrennzeichen.\r\n\
            \x20   + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\r\n\
            \x20   + FullyQualifiedErrorId : MissingTypename\r\n";
        assert!(chain_operator_hint(&ps, "[ -d node_modules ] || npm install", multi).is_some());
        // A marker under something else is not a chain operator.
        let other_marker = "+ [ -d x ] || y\r\n+  ~\r\n    + FullyQualifiedErrorId : MissingTypename\r\n";
        assert!(chain_operator_hint(&ps, "[ -d x ] || y", other_marker).is_none());
        // operators in quoted arguments of commands that failed for another reason
        let other = "Exit code: 1\nstderr:\nerror: pathspec 'y' did not match any file(s) known to git\n";
        assert!(chain_operator_hint(&ps, r#"git commit -m "x && y""#, other).is_none());
        assert!(chain_operator_hint(&ps, "node -e 'process.exit((1 && 2) ? 3 : 0)'", "Exit code: 3\n").is_none());
        assert!(
            chain_operator_hint(&shell(r"C:\Program Files\PowerShell\7\pwsh.exe"), "a && b", parser_error).is_none()
        );
        assert!(chain_operator_hint(&shell("cmd.exe"), "a && b", parser_error).is_none());
        assert!(chain_operator_hint(&shell("sh"), "a && b", parser_error).is_none());
    }

    #[tokio::test]
    async fn failed_chains_in_windows_powershell_get_a_hint() {
        let (ws, _, cp) = setup("chain");
        let r = run("run_command", json!({"command": "cd src && echo chained"}), &ws, &cp).await;
        if cfg!(windows) {
            // the default shell is Windows PowerShell 5.1: parser error on stderr plus hint
            assert!(!r.ok && r.output.contains("InvalidEndOfLine"), "{}", r.output);
            assert!(r.output.contains("has no && or || operators"), "{}", r.output);
            // an operator inside a string is no parser error: a failure for another reason gets no hint
            let r = run("run_command", json!({"command": "Write-Output 'a && b'; exit 3"}), &ws, &cp).await;
            assert!(!r.ok && r.output.contains("a && b") && !r.output.contains("Hint:"), "{}", r.output);
        } else {
            assert!(r.ok && r.output.contains("chained") && !r.output.contains("Hint:"), "{}", r.output);
        }
    }

    #[test]
    fn output_helpers() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m text"), "red text");
        let long = "x".repeat(100);
        let t = truncate_middle(&long, 20);
        assert!(t.contains("80 characters omitted"));
        assert_eq!(describe_call("run_command", &json!({"command": "cargo test"})), "run `cargo test`");
        assert_eq!(describe_call("edit_file", &json!({"path": "a.rs"})), "edit_file a.rs");
    }

    #[test]
    fn every_tool_schema_is_an_object_with_required_fields() {
        for t in all_tools() {
            assert_eq!(t.parameters["type"], "object", "{}", t.name);
            for r in t.parameters["required"].as_array().unwrap() {
                assert!(t.parameters["properties"].get(r.as_str().unwrap()).is_some(), "{}: {r}", t.name);
            }
        }
    }
}
