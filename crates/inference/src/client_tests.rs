//! Client tests against a scripted fake OpenAI server.

use crate::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Serves one canned response per connection; records request bodies.
async fn fake_server(responses: Vec<(u16, String, Vec<String>, u64)>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let recorded = bodies.clone();
    tokio::spawn(async move {
        for (status, content_type, chunks, delay_ms) in responses {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            // read headers + body (Content-Length)
            loop {
                let n = sock.read(&mut tmp).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        recorded.lock().unwrap().push(String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).into_owned());
                        break;
                    }
                }
            }
            let head = format!("HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n");
            let _ = sock.write_all(head.as_bytes()).await;
            for c in chunks {
                if sock.write_all(c.as_bytes()).await.is_err() {
                    break;
                }
                let _ = sock.flush().await;
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            let _ = sock.shutdown().await;
        }
    });
    (url, bodies)
}

fn sse(json: &str) -> String {
    format!("data: {json}\n\n")
}

fn client(url: String) -> LlmClient {
    LlmClient::new(Endpoint {
        base_url: url,
        api_key: Some("k".into()),
        model: Some("local".into()),
    })
}

#[tokio::test]
async fn streams_content_and_reports_deltas() {
    let chunks = vec![
        sse(r#"{"choices":[{"delta":{"content":"Hal"}}]}"#),
        sse(r#"{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}"#),
        sse(r#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}"#),
        "data: [DONE]\n\n".into(),
    ];
    let (url, bodies) = fake_server(vec![(200, "text/event-stream".into(), chunks, 1)]).await;
    let mut deltas = Vec::new();
    let r = client(url)
        .chat(ChatRequest::new(vec![ChatMessage::user("hi")]), &CancellationToken::new(), |d| deltas.push(d))
        .await
        .unwrap();
    assert_eq!(r.message.content.as_deref(), Some("Hallo"));
    assert_eq!(deltas.len(), 2);
    assert_eq!(r.usage.unwrap().completion_tokens, 2);
    let body: serde_json::Value = serde_json::from_str(&bodies.lock().unwrap()[0]).unwrap();
    assert_eq!(body["model"], "local");
    assert_eq!(body["stream"], true);
}

#[tokio::test]
async fn cancellation_returns_partial_answer() {
    let mut chunks = vec![sse(r#"{"choices":[{"delta":{"content":"first "}}]}"#)];
    for _ in 0..50 {
        chunks.push(sse(r#"{"choices":[{"delta":{"content":"more "}}]}"#));
    }
    let (url, _) = fake_server(vec![(200, "text/event-stream".into(), chunks, 40)]).await;
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let r = client(url)
        .chat(ChatRequest::new(vec![ChatMessage::user("hi")]), &cancel, move |_| c2.cancel())
        .await
        .unwrap();
    assert_eq!(r.finish_reason, FinishReason::Cancelled);
    assert!(r.message.content.unwrap().starts_with("first"));
}

#[tokio::test]
async fn server_errors_carry_the_message() {
    let (url, _) = fake_server(vec![(
        400,
        "application/json".into(),
        vec![r#"{"error":{"message":"the request exceeds the available context size"}}"#.into()],
        0,
    )])
    .await;
    let err = client(url)
        .chat(ChatRequest::new(vec![ChatMessage::user("hi")]), &CancellationToken::new(), |_| {})
        .await
        .unwrap_err();
    match err {
        LlmError::Server { status, message } => {
            assert_eq!(status, 400);
            assert!(message.contains("context size"));
        }
        other => panic!("{other}"),
    }
}

#[tokio::test]
async fn error_inside_stream_is_surfaced() {
    let (url, _) = fake_server(vec![(
        200,
        "text/event-stream".into(),
        vec![sse(r#"{"error":{"code":500,"message":"slot unavailable"}}"#)],
        0,
    )])
    .await;
    let err = client(url)
        .chat(ChatRequest::new(vec![ChatMessage::user("hi")]), &CancellationToken::new(), |_| {})
        .await
        .unwrap_err();
    assert!(err.to_string().contains("slot unavailable"));
}

#[tokio::test]
async fn non_streaming_tool_call_response() {
    let body = r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"x","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]},"finish_reason":"tool_calls"}]}"#;
    let (url, _) = fake_server(vec![(200, "application/json".into(), vec![body.into()], 0)]).await;
    let mut req = ChatRequest::new(vec![ChatMessage::user("read a")]);
    req.stream = false;
    let r = client(url).chat(req, &CancellationToken::new(), |_| {}).await.unwrap();
    assert_eq!(r.finish_reason, FinishReason::ToolCalls);
    assert_eq!(r.message.tool_calls[0].function.name, "read_file");
}

#[tokio::test]
async fn embeddings_are_ordered_by_index() {
    let body = r#"{"data":[{"index":1,"embedding":[0.5,0.5]},{"index":0,"embedding":[1.0,0.0]}]}"#;
    let (url, _) = fake_server(vec![(200, "application/json".into(), vec![body.into()], 0)]).await;
    let v = client(url).embeddings(&["a".into(), "b".into()]).await.unwrap();
    assert_eq!(v, vec![vec![1.0, 0.0], vec![0.5, 0.5]]);
}

#[tokio::test]
async fn health_maps_loading_and_unreachable() {
    let (url, _) = fake_server(vec![(503, "application/json".into(), vec!["{}".into()], 0)]).await;
    assert_eq!(client(url).health().await, Health::Loading);
    assert_eq!(client("http://127.0.0.1:9".into()).health().await, Health::Unreachable);
}
