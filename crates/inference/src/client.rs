//! HTTP client for OpenAI-compatible servers, with llama-server extensions
//! (`/health`, `/props`, `/infill`, KV-cache slot pinning).

use crate::openai::{Accumulator, ChatRequest, ChatResult, Delta, SseParser};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

/// Where to send requests. For the managed llama-server this is
/// `http://127.0.0.1:<port>` with a per-session random API key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: Option<String>,
    /// Model name to send (needed by Ollama/LM Studio; ignored by llama-server).
    pub model: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("cannot reach the model server: {0}")]
    Connection(String),
    #[error("model server returned {status}: {message}")]
    Server { status: u16, message: String },
    #[error("model server is still loading the model")]
    Loading,
    #[error("unexpected response from model server: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Health {
    Ready,
    Loading,
    Unreachable,
}

/// One extra file for repository-level fill-in-the-middle.
#[derive(Debug, Clone, Serialize)]
pub struct InfillExtra {
    pub filename: String,
    pub text: String,
}

#[derive(Clone)]
pub struct LlmClient {
    http: reqwest::Client,
    endpoint: Endpoint,
}

impl LlmClient {
    pub fn new(endpoint: Endpoint) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            // Local servers only: never route through a system proxy.
            .no_proxy()
            .build()
            .expect("static reqwest config");
        Self { http, endpoint }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint.base_url.trim_end_matches('/'), path)
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self.http.request(method, self.url(path));
        if let Some(key) = &self.endpoint.api_key {
            rb = rb.bearer_auth(key);
        }
        rb
    }

    async fn check(response: reqwest::Response) -> Result<reqwest::Response, LlmError> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        if status.as_u16() == 503 {
            return Err(LlmError::Loading);
        }
        let body = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or(body);
        Err(LlmError::Server {
            status: status.as_u16(),
            message,
        })
    }

    /// Runs a chat completion. Streams deltas to `on_delta` when `req.stream`.
    /// Cancelling returns the partial answer with `FinishReason::Cancelled`;
    /// closing the connection makes llama-server stop generating.
    pub async fn chat(
        &self,
        mut req: ChatRequest,
        cancel: &CancellationToken,
        mut on_delta: impl FnMut(Delta),
    ) -> Result<ChatResult, LlmError> {
        if req.model.is_none() {
            req.model = self.endpoint.model.clone();
        }
        if !req.stream {
            req.stream_options = None;
        }
        let send = self.request(reqwest::Method::POST, "/v1/chat/completions").json(&req).send();
        let response = tokio::select! {
            _ = cancel.cancelled() => return Ok(Accumulator::default().finish(true)),
            r = send => r.map_err(|e| LlmError::Connection(e.to_string()))?,
        };
        let response = Self::check(response).await?;
        let mut acc = Accumulator::default();

        if !req.stream {
            let body = tokio::select! {
                _ = cancel.cancelled() => return Ok(acc.finish(true)),
                b = response.text() => b.map_err(|e| LlmError::Connection(e.to_string()))?,
            };
            acc.apply(&body).map_err(|e| LlmError::Protocol(e.to_string()))?;
            return Ok(acc.finish(false));
        }

        let mut parser = SseParser::default();
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Ok(acc.finish(true)),
                n = stream.next() => n,
            };
            let ended = next.is_none();
            let events = match next {
                Some(Ok(bytes)) => parser.feed(&bytes),
                Some(Err(e)) => return Err(LlmError::Connection(e.to_string())),
                None => parser.finish().into_iter().collect(),
            };
            for data in events {
                if data.trim() == "[DONE]" {
                    return Ok(acc.finish(false));
                }
                if let Ok(v) = serde_json::from_str::<Value>(&data)
                    && let Some(msg) = v["error"]["message"].as_str()
                {
                    return Err(LlmError::Server {
                        status: 500,
                        message: msg.to_string(),
                    });
                }
                for delta in acc.apply(&data).map_err(|e| LlmError::Protocol(format!("{e}: {data}")))? {
                    on_delta(delta);
                }
            }
            if ended {
                return Ok(acc.finish(false));
            }
        }
    }

    /// Fill-in-the-middle completion via llama-server's `/infill`.
    pub async fn infill(
        &self,
        prefix: &str,
        suffix: &str,
        extra: &[InfillExtra],
        max_tokens: u32,
        cancel: &CancellationToken,
    ) -> Result<String, LlmError> {
        let body = json!({
            "input_prefix": prefix,
            "input_suffix": suffix,
            "input_extra": extra,
            "n_predict": max_tokens,
            "temperature": 0.1,
            "top_k": 40,
            "cache_prompt": true,
            "stream": false,
        });
        let send = self.request(reqwest::Method::POST, "/infill").json(&body).send();
        let response = tokio::select! {
            _ = cancel.cancelled() => return Ok(String::new()),
            r = send => r.map_err(|e| LlmError::Connection(e.to_string()))?,
        };
        let v: Value = Self::check(response)
            .await?
            .json()
            .await
            .map_err(|e| LlmError::Protocol(e.to_string()))?;
        Ok(v["content"].as_str().unwrap_or_default().to_string())
    }

    /// Embeds `inputs` via `/v1/embeddings`.
    pub async fn embeddings(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>, LlmError> {
        let mut body = json!({ "input": inputs, "encoding_format": "float" });
        if let Some(m) = &self.endpoint.model {
            body["model"] = json!(m);
        }
        let response = self
            .request(reqwest::Method::POST, "/v1/embeddings")
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Connection(e.to_string()))?;
        let v: Value = Self::check(response)
            .await?
            .json()
            .await
            .map_err(|e| LlmError::Protocol(e.to_string()))?;
        let mut items: Vec<(u64, Vec<f32>)> = v["data"]
            .as_array()
            .ok_or_else(|| LlmError::Protocol("missing data".into()))?
            .iter()
            .map(|d| {
                let index = d["index"].as_u64().unwrap_or(0);
                let vec = d["embedding"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
                    .unwrap_or_default();
                (index, vec)
            })
            .collect();
        items.sort_by_key(|(i, _)| *i);
        Ok(items.into_iter().map(|(_, v)| v).collect())
    }

    /// llama-server `/health`: 200 when ready, 503 while loading.
    pub async fn health(&self) -> Health {
        match self
            .request(reqwest::Method::GET, "/health")
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => Health::Ready,
            Ok(r) if r.status().as_u16() == 503 => Health::Loading,
            _ => Health::Unreachable,
        }
    }

    /// llama-server `/props` (context size, slots, chat template, ...).
    pub async fn props(&self) -> Result<Value, LlmError> {
        let response = self
            .request(reqwest::Method::GET, "/props")
            .send()
            .await
            .map_err(|e| LlmError::Connection(e.to_string()))?;
        Self::check(response)
            .await?
            .json()
            .await
            .map_err(|e| LlmError::Protocol(e.to_string()))
    }

    /// One raw completion for measuring speed (llama-server `/completion`):
    /// the whole prompt is processed (no prompt cache), then exactly
    /// `n_predict` tokens are generated greedily, so runs are comparable and
    /// their text can be compared.
    pub async fn bench(&self, prompt: &str, n_predict: u32) -> Result<BenchResult, LlmError> {
        let body = json!({
            "prompt": prompt,
            "n_predict": n_predict,
            "ignore_eos": true,
            "cache_prompt": false,
            "temperature": 0.0,
            "top_k": 1,
            "stream": false,
        });
        let response = self
            .request(reqwest::Method::POST, "/completion")
            .json(&body)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| LlmError::Connection(e.to_string()))?;
        let v: Value = Self::check(response).await?.json().await.map_err(|e| LlmError::Protocol(e.to_string()))?;
        parse_bench(&v).ok_or_else(|| LlmError::Protocol("no timings in the /completion response".into()))
    }

    /// Model ids offered by the server (`/v1/models`).
    pub async fn models(&self) -> Result<Vec<String>, LlmError> {
        let response = self
            .request(reqwest::Method::GET, "/v1/models")
            .send()
            .await
            .map_err(|e| LlmError::Connection(e.to_string()))?;
        let v: Value = Self::check(response)
            .await?
            .json()
            .await
            .map_err(|e| LlmError::Protocol(e.to_string()))?;
        Ok(v["data"]
            .as_array()
            .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }
}

/// Speeds of one [`LlmClient::bench`] run, from llama-server's `timings`.
#[derive(Debug, Clone, PartialEq)]
pub struct BenchResult {
    pub content: String,
    pub prompt_tokens: u32,
    pub prompt_per_second: f64,
    pub predicted_tokens: u32,
    pub predicted_per_second: f64,
}

fn parse_bench(v: &Value) -> Option<BenchResult> {
    let t = &v["timings"];
    Some(BenchResult {
        content: v["content"].as_str().unwrap_or_default().to_string(),
        prompt_tokens: t["prompt_n"].as_u64()? as u32,
        prompt_per_second: t["prompt_per_second"].as_f64()?,
        predicted_tokens: t["predicted_n"].as_u64()? as u32,
        predicted_per_second: t["predicted_per_second"].as_f64()?,
    })
}

#[cfg(test)]
mod bench_tests {
    use super::*;

    #[test]
    fn reads_llama_server_timings() {
        // Shape of a b11669 /completion response (shortened).
        let v = json!({
            "content": "fn main() {}",
            "stop": true,
            "timings": {"cache_n": 0, "prompt_n": 3072, "prompt_ms": 1520.4, "prompt_per_second": 2020.5,
                        "predicted_n": 64, "predicted_ms": 1201.0, "predicted_per_second": 53.29}
        });
        let r = parse_bench(&v).unwrap();
        assert_eq!((r.prompt_tokens, r.predicted_tokens), (3072, 64));
        assert_eq!((r.prompt_per_second, r.predicted_per_second), (2020.5, 53.29));
        assert_eq!(r.content, "fn main() {}");
        assert!(parse_bench(&json!({"content": "x"})).is_none(), "a server without timings");
    }
}
