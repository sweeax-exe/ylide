//! Runs `llama-server` as a managed child process.
//!
//! * Binds to 127.0.0.1 on a free port with a random per-launch API key, so other
//!   local programs (or web pages probing localhost) cannot use the model.
//! * Windows: no console window, and a job object kills the server if the IDE
//!   dies. Unix: own process group; a pid file lets the next start clean up orphans.
//! * stdout/stderr go into a ring buffer that the UI can show ("server log").

use crate::client::{Endpoint, Health, LlmClient};
use process_wrap::tokio::*;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{oneshot, watch};
use ts_rs::TS;

const LOG_LINES: usize = 2_000;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub binary: PathBuf,
    /// All arguments except `--host`, `--port` and `--api-key`, which are managed here.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Loading a large model from a slow disk can take minutes.
    pub ready_timeout: Duration,
    /// Where to record the pid for orphan cleanup (optional).
    pub pid_file: Option<PathBuf>,
    /// Folder for the API key file. With it the key is passed as `--api-key-file`
    /// and never appears in the process list; without it `--api-key` is used.
    pub key_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "state")]
#[ts(export)]
pub enum ServerStatus {
    Starting,
    Loading,
    Ready,
    Stopped,
    Crashed { code: Option<i32>, message: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("could not start {binary}: {source}")]
    Spawn { binary: String, source: std::io::Error },
    #[error("llama-server exited during startup (code {code:?}):\n{log_tail}")]
    Exited { code: Option<i32>, log_tail: String },
    #[error("llama-server did not become ready within {seconds}s:\n{log_tail}")]
    Timeout { seconds: u64, log_tail: String },
    #[error("no free local port: {0}")]
    Port(std::io::Error),
}

#[derive(Clone, Default)]
pub struct LogBuffer(Arc<Mutex<VecDeque<String>>>);

impl LogBuffer {
    /// Appends a line (the app also adds its own notes this way).
    pub fn push(&self, line: String) {
        let mut b = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if b.len() == LOG_LINES {
            b.pop_front();
        }
        b.push_back(line);
    }

    pub fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    pub fn tail(&self, n: usize) -> String {
        let b = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let skip = b.len().saturating_sub(n);
        b.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
    }
}

pub struct LlamaServer {
    endpoint: Endpoint,
    status: watch::Receiver<ServerStatus>,
    logs: LogBuffer,
    kill: Option<oneshot::Sender<()>>,
    exited: Option<oneshot::Receiver<()>>,
    pid: Option<u32>,
    pid_file: Option<PathBuf>,
    key_file: Option<PathBuf>,
}

impl LlamaServer {
    /// Starts the server and waits until `/health` reports ready.
    /// `on_log` receives every output line as it arrives.
    pub async fn start(config: ServerConfig, on_log: impl Fn(&str) + Send + Sync + 'static) -> Result<Self, ServerError> {
        if let Some(pid_file) = &config.pid_file {
            kill_orphan(pid_file).await;
        }
        let port = free_port().map_err(ServerError::Port)?;
        let api_key = random_key();
        let endpoint = Endpoint {
            base_url: format!("http://127.0.0.1:{port}"),
            api_key: Some(api_key.clone()),
            model: None,
        };

        let key_file = match &config.key_dir {
            Some(dir) => {
                std::fs::create_dir_all(dir).map_err(|source| ServerError::Spawn {
                    binary: config.binary.display().to_string(),
                    source,
                })?;
                let file = dir.join(format!("llama-{port}.key"));
                std::fs::write(&file, &api_key).map_err(|source| ServerError::Spawn {
                    binary: config.binary.display().to_string(),
                    source,
                })?;
                Some(file)
            }
            None => None,
        };
        let key_args: Vec<String> = match &key_file {
            Some(f) => vec!["--api-key-file".into(), f.display().to_string()],
            None => vec!["--api-key".into(), api_key.clone()],
        };
        let mut wrap = CommandWrap::with_new(&config.binary, |c| {
            c.args(&config.args)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .args(&key_args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(dir) = config.binary.parent() {
                c.current_dir(dir); // backends are loaded from the binary's directory
            }
            for (k, v) in &config.env {
                c.env(k, v);
            }
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
            Ok(child) => child,
            Err(source) => {
                if let Some(f) = &key_file {
                    let _ = std::fs::remove_file(f);
                }
                return Err(ServerError::Spawn {
                    binary: config.binary.display().to_string(),
                    source,
                });
            }
        };
        let pid = child.id();
        if let (Some(file), Some(pid)) = (&config.pid_file, pid) {
            let _ = std::fs::write(file, pid.to_string());
        }

        let logs = LogBuffer::default();
        let on_log = Arc::new(on_log);
        for reader in [
            child.stdout().take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child.stderr().take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let logs = logs.clone();
            let on_log = on_log.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    on_log(&line);
                    logs.push(line);
                }
            });
        }

        let (status_tx, status_rx) = watch::channel(ServerStatus::Starting);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let (exited_tx, exited_rx) = oneshot::channel::<()>();
        {
            let status_tx = status_tx.clone();
            let logs = logs.clone();
            tokio::spawn(async move {
                let exit = tokio::select! {
                    r = child.wait() => Some(r),
                    _ = kill_rx => None,
                };
                match exit {
                    None => {
                        let _ = Box::into_pin(child.kill()).await;
                        let _ = child.wait().await;
                        let _ = status_tx.send(ServerStatus::Stopped);
                    }
                    Some(result) => {
                        let code = result.ok().and_then(|s| s.code());
                        let _ = status_tx.send(ServerStatus::Crashed {
                            code,
                            message: logs.tail(30),
                        });
                    }
                }
                let _ = exited_tx.send(());
            });
        }

        let mut server = Self {
            endpoint: endpoint.clone(),
            status: status_rx,
            logs: logs.clone(),
            kill: Some(kill_tx),
            exited: Some(exited_rx),
            pid,
            pid_file: config.pid_file.clone(),
            key_file,
        };

        // Wait for readiness, a crash or the timeout.
        let client = LlmClient::new(endpoint);
        let started = Instant::now();
        loop {
            let crashed = match &*server.status.borrow() {
                ServerStatus::Crashed { code, .. } => Some(*code),
                _ => None,
            };
            if let Some(code) = crashed {
                server.stop().await; // removes the pid and key files
                return Err(ServerError::Exited {
                    code,
                    log_tail: logs.tail(40),
                });
            }
            match client.health().await {
                Health::Ready => {
                    let _ = status_tx.send(ServerStatus::Ready);
                    break;
                }
                Health::Loading => {
                    let _ = status_tx.send(ServerStatus::Loading);
                }
                Health::Unreachable => {}
            }
            if started.elapsed() > config.ready_timeout {
                server.stop().await;
                return Err(ServerError::Timeout {
                    seconds: config.ready_timeout.as_secs(),
                    log_tail: logs.tail(40),
                });
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        // Keep `status_tx` alive inside the waiter task only.
        drop(status_tx);
        Ok(server)
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub fn client(&self) -> LlmClient {
        LlmClient::new(self.endpoint.clone())
    }

    pub fn status(&self) -> ServerStatus {
        self.status.borrow().clone()
    }

    pub fn watch_status(&self) -> watch::Receiver<ServerStatus> {
        self.status.clone()
    }

    pub fn logs(&self) -> &LogBuffer {
        &self.logs
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Stops the server and waits for the process to exit (frees VRAM).
    pub async fn stop(&mut self) {
        if let Some(kill) = self.kill.take() {
            let _ = kill.send(());
        }
        if let Some(exited) = self.exited.take() {
            let _ = tokio::time::timeout(Duration::from_secs(10), exited).await;
        }
        if let Some(f) = self.pid_file.take() {
            let _ = std::fs::remove_file(f);
        }
        if let Some(f) = self.key_file.take() {
            let _ = std::fs::remove_file(f);
        }
    }
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        if let Some(kill) = self.kill.take() {
            let _ = kill.send(());
        }
    }
}

fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn random_key() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("OS random source");
    hex::encode(bytes)
}

/// How long a start waits for a killed orphan to exit.
const ORPHAN_EXIT_WAIT: Duration = Duration::from_secs(5);

/// Kills a llama-server left behind by a crashed previous session and waits
/// until it has exited: a dying server may still hold VRAM, and the new one
/// would then measure too little free memory for `--fit`.
async fn kill_orphan(pid_file: &Path) {
    let Ok(text) = std::fs::read_to_string(pid_file) else { return };
    let _ = std::fs::remove_file(pid_file);
    let Ok(pid) = text.trim().parse::<u32>() else { return };
    kill_and_wait(sysinfo::Pid::from_u32(pid), "llama-server", ORPHAN_EXIT_WAIT).await;
}

/// Kills `pid` if its program name starts with `name` and waits up to
/// `timeout` for it to exit. False if it is still running afterwards.
async fn kill_and_wait(pid: sysinfo::Pid, name: &str, timeout: Duration) -> bool {
    let Some(sys) = running(pid, name) else { return true };
    tracing::info!("killing orphaned {name} (pid {pid})");
    if let Some(p) = sys.process(pid) {
        p.kill();
    }
    drop(sys); // a handle held here must not keep the process around
    let started = Instant::now();
    while running(pid, name).is_some() {
        if started.elapsed() >= timeout {
            tracing::warn!("orphaned {name} (pid {pid}) still runs {}s after being killed", timeout.as_secs());
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    true
}

/// A fresh snapshot with `pid` if that process runs a program named `name*`
/// (so a pid reused by another program counts as gone).
fn running(pid: sysinfo::Pid, name: &str) -> Option<sysinfo::System> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let matches = sys.process(pid).is_some_and(|p| p.name().to_string_lossy().to_lowercase().starts_with(name));
    matches.then_some(sys)
}

/// A compute device as reported by `llama-server --list-devices`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuntimeDevice {
    /// e.g. "CUDA0", "Vulkan0"
    pub id: String,
    pub description: String,
    #[ts(type = "number | null")]
    pub total_mib: Option<u64>,
    #[ts(type = "number | null")]
    pub free_mib: Option<u64>,
}

/// Runs `<binary> --list-devices` to see which GPUs this backend build can use.
pub async fn list_devices(binary: &Path) -> std::io::Result<Vec<RuntimeDevice>> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("--list-devices").stdin(Stdio::null()).kill_on_drop(true);
    if let Some(dir) = binary.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    cmd.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "--list-devices timed out"))??;
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    Ok(parse_device_list(&text))
}

/// Parses lines like `  Vulkan0: NVIDIA GeForce RTX 5070 Ti (16303 MiB, 15123 MiB free)`.
pub fn parse_device_list(text: &str) -> Vec<RuntimeDevice> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (id, rest) = line.split_once(": ")?;
            if id.is_empty() || id.contains(' ') || !id.chars().last()?.is_ascii_digit() {
                return None;
            }
            let (description, mem) = match rest.rfind(" (") {
                Some(i) if rest.ends_with(')') => (&rest[..i], Some(&rest[i + 2..rest.len() - 1])),
                _ => (rest, None),
            };
            let mut total = None;
            let mut free = None;
            for part in mem.unwrap_or_default().split(',') {
                let part = part.trim();
                let number = part.split_whitespace().next().and_then(|n| n.parse::<u64>().ok());
                if part.ends_with("free") {
                    free = number;
                } else if part.contains("MiB") {
                    total = number;
                }
            }
            Some(RuntimeDevice {
                id: id.to_string(),
                description: description.trim().to_string(),
                total_mib: total,
                free_mib: free,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_device_listing() {
        let out = "ggml_vulkan: Found 1 Vulkan devices:\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 5070 Ti (16303 MiB, 15123 MiB free)\n  CUDA0: NVIDIA GeForce RTX 5070 Ti (16302 MiB, 15000 MiB free)\nload_backend: loaded CPU backend\n";
        let devs = parse_device_list(out);
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].id, "Vulkan0");
        assert_eq!(devs[0].description, "NVIDIA GeForce RTX 5070 Ti");
        assert_eq!(devs[0].total_mib, Some(16303));
        assert_eq!(devs[0].free_mib, Some(15123));
        assert_eq!(devs[1].id, "CUDA0");
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert!(parse_device_list("main: build = 6990\nsystem_info: n_threads = 16\nAvailable devices:\n").is_empty());
    }

    #[test]
    fn random_keys_are_unique_hex() {
        let a = random_key();
        assert_eq!(a.len(), 48);
        assert_ne!(a, random_key());
    }

    #[test]
    fn log_buffer_is_bounded() {
        let b = LogBuffer::default();
        for i in 0..(LOG_LINES + 10) {
            b.push(i.to_string());
        }
        assert_eq!(b.lines().len(), LOG_LINES);
        assert_eq!(b.tail(1), (LOG_LINES + 9).to_string());
    }

    /// An empty folder under the system temp dir, removed again by the test.
    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ylide-server-test-{}", random_key()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn files_in(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()
    }

    #[tokio::test]
    async fn missing_binary_is_a_spawn_error() {
        let dir = scratch_dir();
        let err = LlamaServer::start(
            ServerConfig {
                binary: PathBuf::from("definitely-not-a-real-llama-server.exe"),
                args: vec![],
                env: vec![],
                ready_timeout: Duration::from_secs(1),
                pid_file: None,
                key_dir: Some(dir.clone()),
            },
            |_| {},
        )
        .await
        .err()
        .unwrap();
        let left = files_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(err, ServerError::Spawn { .. }), "{err}");
        assert!(left.is_empty(), "the key file is removed again: {left:?}");
    }

    #[tokio::test]
    async fn exit_during_startup_removes_key_and_pid_files() {
        // Any program that exits right away stands in for a crashing llama-server.
        #[cfg(windows)]
        let (binary, args) = (
            PathBuf::from(std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into())),
            ["/c", "exit", "3"],
        );
        #[cfg(unix)]
        let (binary, args) = (PathBuf::from("/bin/sh"), ["-c", "exit 3", "sh"]);
        let dir = scratch_dir();
        let err = LlamaServer::start(
            ServerConfig {
                binary,
                args: args.iter().map(|a| a.to_string()).collect(),
                env: vec![],
                ready_timeout: Duration::from_secs(60),
                pid_file: Some(dir.join("chat.pid")),
                key_dir: Some(dir.clone()),
            },
            |_| {},
        )
        .await
        .err()
        .unwrap();
        let left = files_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(err, ServerError::Exited { .. }), "{err}");
        assert!(left.is_empty(), "no llama-<port>.key or chat.pid left behind: {left:?}");
    }

    #[tokio::test]
    async fn killing_an_orphan_waits_until_it_has_exited() {
        #[cfg(windows)]
        let (program, args, name) = ("ping", ["-n", "60", "127.0.0.1"], "ping");
        #[cfg(unix)]
        let (program, args, name) = ("sleep", ["60"], "sleep");
        let mut child = std::process::Command::new(program).args(args).stdout(Stdio::null()).spawn().unwrap();
        let pid = sysinfo::Pid::from_u32(child.id());

        // Only processes with the expected name are touched (the pid may have been reused).
        assert!(kill_and_wait(pid, "llama-server", Duration::from_secs(5)).await);
        assert!(child.try_wait().unwrap().is_none(), "another program is left alone");

        assert!(kill_and_wait(pid, name, Duration::from_secs(10)).await);
        assert!(child.try_wait().unwrap().is_some(), "the process has exited");
    }
}
