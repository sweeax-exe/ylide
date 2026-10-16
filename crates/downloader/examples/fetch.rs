//! Downloads one file with resume and checksum verification:
//! `cargo run -p downloader --example fetch -- <url> <dest> <size> <sha256>`

use std::time::{Duration, Instant};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [url, dest, size, sha] = args.as_slice() else {
        eprintln!("usage: fetch <url> <dest> <size-bytes> <sha256>");
        std::process::exit(2);
    };
    let spec = downloader::FileSpec {
        url: url.clone(),
        dest: dest.into(),
        size_bytes: size.parse().expect("size in bytes"),
        sha256: sha.to_lowercase(),
    };
    let client = reqwest::Client::builder().user_agent(concat!("Ylide/", env!("CARGO_PKG_VERSION"))).build().unwrap();
    let dl = downloader::Downloader::new(client);
    let cancel = tokio_util::sync::CancellationToken::new();
    let started = Instant::now();
    let mut last = Instant::now() - Duration::from_secs(10);
    let result = dl
        .download("fetch", std::slice::from_ref(&spec), &cancel, |p| {
            if last.elapsed() > Duration::from_secs(2) || p.phase != downloader::DownloadPhase::Downloading {
                last = Instant::now();
                println!(
                    "{:?}: {:.1} / {:.1} GB at {:.0} MB/s",
                    p.phase,
                    p.downloaded_bytes as f64 / 1e9,
                    p.total_bytes as f64 / 1e9,
                    p.bytes_per_second / 1e6
                );
            }
        })
        .await;
    match result {
        Ok(()) => println!("done in {:.0}s, SHA-256 verified: {}", started.elapsed().as_secs_f64(), spec.dest.display()),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}
