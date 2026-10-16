//! Resumable, checksum-verified HTTP downloads.
//!
//! * Data is written to `<dest>.part`; only a fully verified file is renamed to `dest`,
//!   so an existing `dest` with the expected size is trusted as complete.
//! * Pausing is cancelling: the `.part` file stays and the next run continues
//!   with an HTTP `Range` request. Servers that ignore `Range` restart cleanly.
//! * The SHA-256 is computed while streaming; on resume the existing part is
//!   hashed first, so the final check always covers every byte on disk.
//! * Transient failures (connection drops, 5xx, 429) are retried with backoff.

use futures_util::StreamExt;
use reqwest::StatusCode;
use reqwest::header::{CONTENT_RANGE, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

/// One file to fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSpec {
    pub url: String,
    pub dest: PathBuf,
    pub size_bytes: u64,
    /// Lower-case hex SHA-256.
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DownloadPhase {
    /// Re-hashing a partial file from a previous run.
    Resuming,
    Downloading,
    /// Computing the final checksum and moving the file into place.
    Verifying,
    Done,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Progress {
    pub job_id: String,
    pub phase: DownloadPhase,
    pub file_index: u32,
    pub file_count: u32,
    /// Bytes on disk across all files of the job.
    #[ts(type = "number")]
    pub downloaded_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub bytes_per_second: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("download cancelled")]
    Cancelled,
    #[error("server answered {status} for {url}")]
    Http { status: u16, url: String },
    #[error("network error: {0}")]
    Network(String),
    #[error("file system error: {0}")]
    Io(#[from] std::io::Error),
    #[error("checksum mismatch for {path}: expected {expected}, got {actual}")]
    ChecksumMismatch { path: String, expected: String, actual: String },
    #[error("size mismatch for {path}: expected {expected} bytes, got {actual}")]
    SizeMismatch { path: String, expected: u64, actual: u64 },
    #[error("server sent an unexpected range: {0}")]
    BadRange(String),
}

impl DownloadError {
    fn is_transient(&self) -> bool {
        match self {
            Self::Network(_) => true,
            Self::Http { status, .. } => *status == 429 || *status == 408 || *status >= 500,
            _ => false,
        }
    }
}

/// Called with every URL before it is requested (network transparency log).
pub type AuditHook = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct Downloader {
    client: reqwest::Client,
    audit: Option<AuditHook>,
    max_retries: u32,
    retry_base: Duration,
    progress_interval: Duration,
}

impl Downloader {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            audit: None,
            max_retries: 6,
            retry_base: Duration::from_millis(800),
            progress_interval: Duration::from_millis(200),
        }
    }

    pub fn with_audit(mut self, hook: AuditHook) -> Self {
        self.audit = Some(hook);
        self
    }

    pub fn with_retry(mut self, max_retries: u32, base: Duration) -> Self {
        self.max_retries = max_retries;
        self.retry_base = base;
        self
    }

    /// Downloads all `files`. Returns `Err(Cancelled)` when `cancel` fires;
    /// calling again later resumes where it stopped.
    pub async fn download(
        &self,
        job_id: &str,
        files: &[FileSpec],
        cancel: &CancellationToken,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<(), DownloadError> {
        let total: u64 = files.iter().map(|f| f.size_bytes).sum();
        let mut done_before: u64 = 0;
        let mut meter = SpeedMeter::default();
        for (index, file) in files.iter().enumerate() {
            let mut report = |phase: DownloadPhase, file_bytes: u64, speed: f64| {
                on_progress(Progress {
                    job_id: job_id.to_string(),
                    phase,
                    file_index: index as u32,
                    file_count: files.len() as u32,
                    downloaded_bytes: done_before + file_bytes,
                    total_bytes: total,
                    bytes_per_second: speed,
                })
            };
            self.download_one(file, cancel, &mut meter, &mut report).await?;
            done_before += file.size_bytes;
        }
        on_progress(Progress {
            job_id: job_id.to_string(),
            phase: DownloadPhase::Done,
            file_index: files.len().saturating_sub(1) as u32,
            file_count: files.len() as u32,
            downloaded_bytes: total,
            total_bytes: total,
            bytes_per_second: 0.0,
        });
        Ok(())
    }

    async fn download_one(
        &self,
        file: &FileSpec,
        cancel: &CancellationToken,
        meter: &mut SpeedMeter,
        report: &mut impl FnMut(DownloadPhase, u64, f64),
    ) -> Result<(), DownloadError> {
        if let Ok(meta) = fs::metadata(&file.dest).await
            && meta.len() == file.size_bytes
        {
            report(DownloadPhase::Verifying, file.size_bytes, 0.0);
            return Ok(());
        }
        if let Some(parent) = file.dest.parent() {
            fs::create_dir_all(parent).await?;
        }
        let part = part_path(&file.dest);

        // Re-hash what an earlier run left behind.
        let mut hasher = Sha256::new();
        let mut offset = match fs::metadata(&part).await {
            Ok(m) if m.len() <= file.size_bytes => m.len(),
            Ok(_) => {
                fs::remove_file(&part).await?;
                0
            }
            Err(_) => 0,
        };
        if offset > 0 {
            report(DownloadPhase::Resuming, 0, 0.0);
            hash_file_prefix(&part, offset, &mut hasher, cancel).await?;
        }

        let mut attempt = 0u32;
        while offset < file.size_bytes {
            match self.fetch_range(file, &part, &mut offset, &mut hasher, cancel, meter, report).await {
                Ok(()) => {}
                Err(e) if e.is_transient() && attempt < self.max_retries => {
                    attempt += 1;
                    let delay = self.retry_base * 2u32.pow(attempt.min(6) - 1);
                    tracing::warn!("download of {} interrupted ({e}), retry {attempt} in {delay:?}", file.url);
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(DownloadError::Cancelled),
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
                Err(e) => return Err(e),
            }
        }

        report(DownloadPhase::Verifying, offset, 0.0);
        let actual_size = fs::metadata(&part).await?.len();
        if actual_size != file.size_bytes {
            return Err(DownloadError::SizeMismatch {
                path: file.dest.display().to_string(),
                expected: file.size_bytes,
                actual: actual_size,
            });
        }
        let actual = hex::encode(hasher.finalize());
        if actual != file.sha256 {
            fs::remove_file(&part).await?;
            return Err(DownloadError::ChecksumMismatch {
                path: file.dest.display().to_string(),
                expected: file.sha256.clone(),
                actual,
            });
        }
        fs::rename(&part, &file.dest).await?;
        Ok(())
    }

    /// One HTTP request continuing at `offset`. Advances `offset` as data arrives.
    #[allow(clippy::too_many_arguments)]
    async fn fetch_range(
        &self,
        file: &FileSpec,
        part: &Path,
        offset: &mut u64,
        hasher: &mut Sha256,
        cancel: &CancellationToken,
        meter: &mut SpeedMeter,
        report: &mut impl FnMut(DownloadPhase, u64, f64),
    ) -> Result<(), DownloadError> {
        if let Some(audit) = &self.audit {
            audit(&file.url);
        }
        let mut request = self.client.get(&file.url);
        if *offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(DownloadError::Cancelled),
            r = request.send() => r.map_err(|e| DownloadError::Network(e.to_string()))?,
        };
        let status = response.status();

        if status == StatusCode::RANGE_NOT_SATISFIABLE && *offset == file.size_bytes {
            return Ok(());
        }
        if !status.is_success() {
            return Err(DownloadError::Http {
                status: status.as_u16(),
                url: file.url.clone(),
            });
        }

        let mut out = if *offset > 0 && status == StatusCode::PARTIAL_CONTENT {
            let range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            if range_start(&range) != Some(*offset) {
                return Err(DownloadError::BadRange(range));
            }
            OpenOptions::new().append(true).open(part).await?
        } else {
            // Fresh start, or the server ignored our Range header.
            *offset = 0;
            *hasher = Sha256::new();
            File::create(part).await?
        };

        let mut stream = response.bytes_stream();
        let mut last_report = Instant::now() - Duration::from_secs(1);
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => {
                    out.flush().await?;
                    return Err(DownloadError::Cancelled);
                }
                n = stream.next() => n,
            };
            let Some(chunk) = next else { break };
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    out.flush().await?;
                    return Err(DownloadError::Network(e.to_string()));
                }
            };
            if *offset + chunk.len() as u64 > file.size_bytes {
                return Err(DownloadError::SizeMismatch {
                    path: file.dest.display().to_string(),
                    expected: file.size_bytes,
                    actual: *offset + chunk.len() as u64,
                });
            }
            out.write_all(&chunk).await?;
            hasher.update(&chunk);
            *offset += chunk.len() as u64;
            meter.add(chunk.len() as u64);
            if last_report.elapsed() >= self.progress_interval {
                last_report = Instant::now();
                report(DownloadPhase::Downloading, *offset, meter.bytes_per_second());
            }
        }
        out.flush().await?;
        if *offset < file.size_bytes {
            // Connection closed early without an error: treat as transient.
            return Err(DownloadError::Network("connection closed before end of file".into()));
        }
        Ok(())
    }
}

/// Removes leftovers of an aborted download (used for "cancel and delete").
pub async fn discard_partial(files: &[FileSpec]) -> std::io::Result<()> {
    for f in files {
        match fs::remove_file(part_path(&f.dest)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// Bytes already on disk for these files (complete files and `.part` files).
pub async fn bytes_on_disk(files: &[FileSpec]) -> u64 {
    let mut total = 0;
    for f in files {
        if let Ok(m) = fs::metadata(&f.dest).await {
            total += m.len();
        } else if let Ok(m) = fs::metadata(part_path(&f.dest)).await {
            total += m.len();
        }
    }
    total
}

pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

async fn hash_file_prefix(path: &Path, len: u64, hasher: &mut Sha256, cancel: &CancellationToken) -> Result<(), DownloadError> {
    let mut f = File::open(path).await?;
    let mut buf = vec![0u8; 1 << 20];
    let mut remaining = len;
    while remaining > 0 {
        if cancel.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }
        let want = remaining.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

/// Parses the start of `Content-Range: bytes 100-999/1000`.
fn range_start(header: &str) -> Option<u64> {
    header.strip_prefix("bytes ")?.split('-').next()?.trim().parse().ok()
}

/// Exponentially smoothed throughput.
#[derive(Default)]
struct SpeedMeter {
    window_start: Option<Instant>,
    window_bytes: u64,
    smoothed: f64,
}

impl SpeedMeter {
    fn add(&mut self, bytes: u64) {
        let now = Instant::now();
        let start = *self.window_start.get_or_insert(now);
        self.window_bytes += bytes;
        let elapsed = now.duration_since(start).as_secs_f64();
        if elapsed >= 0.5 {
            let rate = self.window_bytes as f64 / elapsed;
            self.smoothed = if self.smoothed == 0.0 { rate } else { self.smoothed * 0.7 + rate * 0.3 };
            self.window_start = Some(now);
            self.window_bytes = 0;
        }
    }

    fn bytes_per_second(&self) -> f64 {
        self.smoothed
    }
}

#[cfg(test)]
mod tests;
