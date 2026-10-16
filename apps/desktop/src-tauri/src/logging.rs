//! Log output: the console during development and, in every build, a file the
//! user can send along with a bug report (`<local data>/logs/ylide.log`; the
//! previous run is kept as `ylide.previous.log`). Panics are logged as well.
//!
//! Logging starts before the app folders exist (the migration may still move
//! them), so the file is attached later; lines written before that reach only
//! the console.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

pub const LOG_FILE: &str = "ylide.log";
const PREVIOUS_LOG_FILE: &str = "ylide.previous.log";

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

/// Writes to the log file once one is attached, and drops lines before that.
struct FileSink;

impl Write for FileSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match FILE.get() {
            Some(file) => file.lock().unwrap_or_else(|e| e.into_inner()).write(buf),
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match FILE.get() {
            Some(file) => file.lock().unwrap_or_else(|e| e.into_inner()).flush(),
            None => Ok(()),
        }
    }
}

/// Sets up logging to the console and to the (not yet attached) file, and
/// sends panics to the log.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .with(fmt::layer().with_ansi(false).with_writer(|| FileSink))
        .init();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_hook(info);
    }));
}

/// Starts the log file in `dir`, keeping the previous run's file.
pub fn attach_file(dir: &Path) -> std::io::Result<PathBuf> {
    let path = rotate(dir)?;
    let file = File::create(&path)?;
    let _ = FILE.set(Mutex::new(file));
    tracing::info!("Ylide {} on {} {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    Ok(path)
}

/// Moves the last run's log aside and returns the path for this run's log.
fn rotate(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    if path.exists() {
        std::fs::rename(&path, dir.join(PREVIOUS_LOG_FILE))?;
    }
    Ok(path)
}

/// The log folder of the app with this identifier: inside the local data
/// folder, the same one Tauri's `app_local_data_dir` returns.
pub fn log_dir(identifier: &str) -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(identifier).join("logs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_previous_run() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let path = rotate(&logs).unwrap();
        assert_eq!(path, logs.join(LOG_FILE));
        std::fs::write(&path, "run 1\n").unwrap();
        rotate(&logs).unwrap();
        std::fs::write(&path, "run 2\n").unwrap();
        rotate(&logs).unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(logs.join(PREVIOUS_LOG_FILE)).unwrap(), "run 2\n");
    }

    #[test]
    fn log_dir_is_inside_the_local_data_folder() {
        let dir = log_dir("app.ylide").unwrap();
        assert!(dir.ends_with(Path::new("app.ylide").join("logs")));
    }
}
