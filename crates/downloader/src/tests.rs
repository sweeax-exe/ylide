//! Tests against a tiny in-process HTTP server that can drop connections,
//! ignore `Range`, or fail with 5xx/404 on demand.

use super::*;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::net::TcpListener;

#[derive(Clone, Default)]
struct Behavior {
    ignore_range: bool,
    /// For the first `drop_count` requests, close the socket after this many body bytes.
    drop_after: Option<usize>,
    drop_count: usize,
    /// Answer the first N requests with this status.
    fail_first: Option<(usize, u16)>,
}

struct Server {
    url: String,
    requests: Arc<AtomicUsize>,
    ranges: Arc<Mutex<Vec<Option<u64>>>>,
}

async fn serve(data: Arc<Vec<u8>>, behavior: Behavior) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let ranges = Arc::new(Mutex::new(Vec::new()));
    let (req_c, ranges_c) = (requests.clone(), ranges.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let n = req_c.fetch_add(1, Ordering::SeqCst);
            let data = data.clone();
            let behavior = behavior.clone();
            let ranges = ranges_c.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if sock.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_lowercase();
                let range = head
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .and_then(|r| r.trim_end_matches('-').trim_end_matches("-\r").split('-').next().map(str::to_string))
                    .and_then(|s| s.trim().parse::<u64>().ok());
                ranges.lock().unwrap().push(range);

                if let Some((count, status)) = behavior.fail_first
                    && n < count
                {
                    let _ = sock
                        .write_all(format!("HTTP/1.1 {status} Fail\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
                        .await;
                    return;
                }
                let start = match range {
                    Some(s) if !behavior.ignore_range => s as usize,
                    _ => 0,
                };
                let header = if start >= data.len() && range.is_some() && !behavior.ignore_range {
                    let _ = sock
                        .write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", data.len()).as_bytes())
                        .await;
                    return;
                } else if start > 0 {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                        data.len() - start,
                        start,
                        data.len() - 1,
                        data.len()
                    )
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len())
                };
                if sock.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                let body = &data[start..];
                let body = match behavior.drop_after {
                    Some(limit) if n < behavior.drop_count => &body[..limit.min(body.len())],
                    _ => body,
                };
                let _ = sock.write_all(body).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    Server {
        url: format!("http://{addr}/model.gguf"),
        requests,
        ranges,
    }
}

fn payload(len: usize) -> Arc<Vec<u8>> {
    Arc::new((0..len).map(|i| (i * 31 % 251) as u8).collect())
}

fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("downloader-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn downloader() -> Downloader {
    Downloader::new(reqwest::Client::new()).with_retry(5, Duration::from_millis(5))
}

fn spec(server: &Server, dir: &Path, data: &[u8]) -> FileSpec {
    FileSpec {
        url: server.url.clone(),
        dest: dir.join("model.gguf"),
        size_bytes: data.len() as u64,
        sha256: sha(data),
    }
}

#[tokio::test]
async fn downloads_and_verifies() {
    let data = payload(300_000);
    let server = serve(data.clone(), Behavior::default()).await;
    let dir = temp("full");
    let file = spec(&server, &dir, &data);
    let mut last = None;
    downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |p| last = Some(p))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&file.dest).unwrap(), *data);
    assert!(!part_path(&file.dest).exists());
    let last = last.unwrap();
    assert_eq!(last.phase, DownloadPhase::Done);
    assert_eq!(last.downloaded_bytes, data.len() as u64);
}

#[tokio::test]
async fn resumes_after_dropped_connections() {
    let data = payload(200_000);
    let server = serve(
        data.clone(),
        Behavior {
            drop_after: Some(40_000),
            drop_count: 2,
            ..Behavior::default()
        },
    )
    .await;
    let dir = temp("drop");
    let file = spec(&server, &dir, &data);
    downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(std::fs::read(&file.dest).unwrap(), *data);
    let ranges = server.ranges.lock().unwrap().clone();
    assert_eq!(ranges, vec![None, Some(40_000), Some(80_000)]);
}

#[tokio::test]
async fn continues_from_existing_part_file() {
    let data = payload(100_000);
    let server = serve(data.clone(), Behavior::default()).await;
    let dir = temp("part");
    let file = spec(&server, &dir, &data);
    std::fs::write(part_path(&file.dest), &data[..60_000]).unwrap();
    let mut phases = Vec::new();
    downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |p| phases.push(p.phase))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&file.dest).unwrap(), *data);
    assert_eq!(server.ranges.lock().unwrap().clone(), vec![Some(60_000)]);
    assert_eq!(phases.first(), Some(&DownloadPhase::Resuming));
}

#[tokio::test]
async fn restarts_when_server_ignores_range() {
    let data = payload(80_000);
    let server = serve(
        data.clone(),
        Behavior {
            ignore_range: true,
            ..Behavior::default()
        },
    )
    .await;
    let dir = temp("ignore-range");
    let file = spec(&server, &dir, &data);
    std::fs::write(part_path(&file.dest), &data[..30_000]).unwrap();
    downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(std::fs::read(&file.dest).unwrap(), *data);
}

#[tokio::test]
async fn rejects_checksum_mismatch_and_discards_part() {
    let data = payload(50_000);
    let server = serve(data.clone(), Behavior::default()).await;
    let dir = temp("mismatch");
    let mut file = spec(&server, &dir, &data);
    file.sha256 = "0".repeat(64);
    let err = downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |_| {})
        .await
        .unwrap_err();
    assert!(matches!(err, DownloadError::ChecksumMismatch { .. }), "{err}");
    assert!(!file.dest.exists());
    assert!(!part_path(&file.dest).exists());
}

#[tokio::test]
async fn retries_server_errors_but_not_404() {
    let data = payload(10_000);
    let flaky = serve(
        data.clone(),
        Behavior {
            fail_first: Some((2, 503)),
            ..Behavior::default()
        },
    )
    .await;
    let dir = temp("retry");
    let file = spec(&flaky, &dir, &data);
    downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(flaky.requests.load(Ordering::SeqCst), 3);

    let missing = serve(
        data.clone(),
        Behavior {
            fail_first: Some((100, 404)),
            ..Behavior::default()
        },
    )
    .await;
    let dir = temp("404");
    let file = spec(&missing, &dir, &data);
    let err = downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |_| {})
        .await
        .unwrap_err();
    assert!(matches!(err, DownloadError::Http { status: 404, .. }));
    assert_eq!(missing.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn skips_complete_files_without_network() {
    let data = payload(1_000);
    let server = serve(data.clone(), Behavior::default()).await;
    let dir = temp("existing");
    let file = spec(&server, &dir, &data);
    std::fs::write(&file.dest, &*data).unwrap();
    downloader()
        .download("job", std::slice::from_ref(&file), &CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancellation_keeps_part_for_resume() {
    let data = payload(10_000);
    let server = serve(data.clone(), Behavior::default()).await;
    let dir = temp("cancel");
    let file = spec(&server, &dir, &data);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let err = downloader()
        .download("job", std::slice::from_ref(&file), &cancel, |_| {})
        .await
        .unwrap_err();
    assert!(matches!(err, DownloadError::Cancelled));
    discard_partial(std::slice::from_ref(&file)).await.unwrap();
    assert_eq!(bytes_on_disk(std::slice::from_ref(&file)).await, 0);
}

#[tokio::test]
async fn multi_file_jobs_report_combined_progress() {
    let a = payload(20_000);
    let b = payload(30_000);
    let sa = serve(a.clone(), Behavior::default()).await;
    let sb = serve(b.clone(), Behavior::default()).await;
    let dir = temp("multi");
    let files = vec![
        FileSpec {
            url: sa.url.clone(),
            dest: dir.join("m-00001-of-00002.gguf"),
            size_bytes: a.len() as u64,
            sha256: sha(&a),
        },
        FileSpec {
            url: sb.url.clone(),
            dest: dir.join("m-00002-of-00002.gguf"),
            size_bytes: b.len() as u64,
            sha256: sha(&b),
        },
    ];
    let audited = Arc::new(Mutex::new(Vec::new()));
    let log = audited.clone();
    let mut last = None;
    downloader()
        .with_audit(Arc::new(move |url: &str| log.lock().unwrap().push(url.to_string())))
        .download("job", &files, &CancellationToken::new(), |p| last = Some(p))
        .await
        .unwrap();
    let last = last.unwrap();
    assert_eq!(last.total_bytes, 50_000);
    assert_eq!(last.file_count, 2);
    assert_eq!(audited.lock().unwrap().len(), 2, "every request goes through the audit hook");
}

#[test]
fn parses_content_range() {
    assert_eq!(range_start("bytes 100-999/1000"), Some(100));
    assert_eq!(range_start("bytes */1000"), None);
    assert_eq!(range_start(""), None);
}

#[test]
fn part_path_appends_suffix() {
    assert_eq!(part_path(Path::new("/m/a.gguf")), PathBuf::from("/m/a.gguf.part"));
}
