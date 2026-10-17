//! OpenAI-compatible chat types (as served by llama.cpp's `llama-server`,
//! Ollama, LM Studio, ...) plus the streaming machinery: an incremental SSE
//! parser and an accumulator that assembles streamed tool calls.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// A message as sent to the server. With images, the content goes out as an
/// array of `image_url` and `text` parts (its `Serialize` is written by hand).
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
#[ts(export)]
pub struct ChatMessage {
    pub role: MessageRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Thinking text of reasoning models (`reasoning_content` in llama-server).
    /// Never sent back to the model.
    #[serde(default, skip_serializing)]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Images that go with the text, as data URLs (see [`crate::image`]).
    /// Only a model with its vision projector loaded can take them.
    #[serde(skip)]
    #[ts(skip)]
    pub images: Vec<String>,
}

impl Serialize for ChatMessage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("role", &self.role)?;
        if self.images.is_empty() {
            if let Some(content) = &self.content {
                map.serialize_entry("content", content)?;
            }
        } else {
            // Images first, then the text that refers to them, as vision models are trained.
            let mut parts: Vec<Value> = self.images.iter().map(|url| serde_json::json!({"type": "image_url", "image_url": {"url": url}})).collect();
            if let Some(text) = self.content.as_deref().filter(|t| !t.is_empty()) {
                parts.push(serde_json::json!({"type": "text", "text": text}));
            }
            map.serialize_entry("content", &parts)?;
        }
        if !self.tool_calls.is_empty() {
            map.serialize_entry("tool_calls", &self.tool_calls)?;
        }
        if let Some(id) = &self.tool_call_id {
            map.serialize_entry("tool_call_id", id)?;
        }
        map.end()
    }
}

impl ChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self::text(MessageRole::System, text)
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self::text(MessageRole::User, text)
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self::text(MessageRole::Assistant, text)
    }
    pub fn tool_result(call_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            tool_call_id: Some(call_id.into()),
            ..Self::text(MessageRole::Tool, text)
        }
    }
    fn text(role: MessageRole, text: impl Into<String>) -> Self {
        Self {
            role,
            content: Some(text.into()),
            reasoning_content: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            images: Vec::new(),
        }
    }

    /// The message with images (data URLs) attached.
    pub fn with_images(mut self, images: Vec<String>) -> Self {
        self.images = images;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "function_type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn function_type() -> String {
    "function".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded arguments, exactly as produced by the model.
    pub arguments: String,
}

/// A tool the model may call (OpenAI "function" tool).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionDefinition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments object.
    pub parameters: Value,
}

impl ToolDefinition {
    pub fn function(name: &str, description: &str, parameters: Value) -> Self {
        Self {
            kind: "function".into(),
            function: FunctionDefinition {
                name: name.into(),
                description: description.into(),
                parameters,
            },
        }
    }
}

/// Sampling parameters. `None` means "server default".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SamplingParams {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub min_p: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub repeat_penalty: Option<f64>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChatRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_penalty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stop: Vec<String>,
    /// e.g. `{"type":"json_schema","json_schema":{...}}` - llama-server turns it into a grammar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
    /// llama-server: pin the request to a slot to reuse its KV cache.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_slot: Option<i32>,
    /// llama-server: reuse the cached prompt prefix (default true on recent builds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_prompt: Option<bool>,
    /// Ask the server to append usage to the final stream chunk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_options: Option<Value>,
    /// Template switches such as `{"enable_thinking": false}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_template_kwargs: Option<Value>,
    /// Server-specific fields (e.g. llama-server's `reasoning_budget_tokens`), sent as-is.
    #[serde(flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
    /// A short text answer beside the agents' work (a summary, notes): the app
    /// gives it its chat defaults, which keep thinking off or low, so the
    /// answer is not used up by reasoning. Not sent.
    #[serde(skip)]
    pub quick: bool,
}

impl ChatRequest {
    pub fn new(messages: Vec<ChatMessage>) -> Self {
        Self {
            messages,
            stream: true,
            cache_prompt: Some(true),
            stream_options: Some(serde_json::json!({ "include_usage": true })),
            ..Self::default()
        }
    }

    pub fn with_sampling(mut self, s: &SamplingParams) -> Self {
        self.temperature = s.temperature;
        self.top_p = s.top_p;
        self.top_k = s.top_k;
        self.min_p = s.min_p;
        self.presence_penalty = s.presence_penalty;
        self.repeat_penalty = s.repeat_penalty;
        self.max_tokens = s.max_tokens;
        self
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// Prompt tokens served from the KV cache (llama-server `timings.cache_n`).
    pub cached_tokens: u32,
}

/// Throughput reported by llama-server in the final chunk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Timings {
    pub prompt_tokens_per_second: f64,
    pub generation_tokens_per_second: f64,
    pub prompt_ms: f64,
    pub generation_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FinishReason {
    Stop,
    Length,
    ToolCalls,
    Cancelled,
    Other,
}

/// The assembled result of a (streamed) chat completion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatResult {
    pub message: ChatMessage,
    pub finish_reason: FinishReason,
    pub usage: Option<Usage>,
    pub timings: Option<Timings>,
}

/// Incremental piece of a streamed answer, forwarded to the UI as it arrives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
#[ts(export)]
pub enum Delta {
    Content { text: String },
    Reasoning { text: String },
    /// A tool call is being generated (name known, arguments streaming).
    ToolCall { index: u32, name: String },
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/// Incremental SSE parser: feed raw bytes, get complete `data:` payloads.
/// Handles CRLF, multi-line data fields, comments and chunk boundaries anywhere.
#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            }
            // `event:`, `id:`, `retry:` and `:comments` are irrelevant here.
        }
        events
    }

    /// Flushes a trailing event that was not terminated by a blank line.
    pub fn finish(&mut self) -> Option<String> {
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            let line = String::from_utf8_lossy(&rest).trim_end().to_string();
            if let Some(d) = line.strip_prefix("data:") {
                self.data.push(d.trim_start().to_string());
            }
        }
        (!self.data.is_empty()).then(|| std::mem::take(&mut self.data).join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Chunk accumulation
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<ChunkUsage>,
    #[serde(default)]
    timings: Option<ChunkTimings>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    #[serde(default)]
    delta: Option<ChunkDelta>,
    /// Non-streaming responses carry `message` instead of `delta`.
    #[serde(default)]
    message: Option<ChunkDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct ChunkDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ChunkToolCall>>,
}

#[derive(Deserialize)]
struct ChunkToolCall {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<ChunkFunction>,
}

#[derive(Deserialize)]
struct ChunkFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct ChunkUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

#[derive(Deserialize)]
struct ChunkTimings {
    #[serde(default)]
    cache_n: Option<u32>,
    #[serde(default)]
    prompt_n: Option<u32>,
    #[serde(default)]
    prompt_ms: Option<f64>,
    #[serde(default)]
    prompt_per_second: Option<f64>,
    #[serde(default)]
    predicted_n: Option<u32>,
    #[serde(default)]
    predicted_ms: Option<f64>,
    #[serde(default)]
    predicted_per_second: Option<f64>,
}

/// Folds stream chunks into a [`ChatResult`].
#[derive(Default)]
pub struct Accumulator {
    content: String,
    reasoning: String,
    calls: Vec<(String, String, String)>, // id, name, arguments
    finish: Option<String>,
    usage: Option<Usage>,
    timings: Option<Timings>,
}

impl Accumulator {
    /// Applies one JSON chunk; returns the deltas to forward.
    pub fn apply(&mut self, json: &str) -> Result<Vec<Delta>, serde_json::Error> {
        let chunk: Chunk = serde_json::from_str(json)?;
        let mut out = Vec::new();
        for choice in chunk.choices {
            let delta = choice.delta.or(choice.message).unwrap_or_default();
            if let Some(text) = delta.reasoning_content.filter(|t| !t.is_empty()) {
                self.reasoning.push_str(&text);
                out.push(Delta::Reasoning { text });
            }
            if let Some(text) = delta.content.filter(|t| !t.is_empty()) {
                self.content.push_str(&text);
                out.push(Delta::Content { text });
            }
            for (pos, tc) in delta.tool_calls.unwrap_or_default().into_iter().enumerate() {
                let index = tc.index.unwrap_or(pos as u32) as usize;
                while self.calls.len() <= index {
                    self.calls.push((String::new(), String::new(), String::new()));
                }
                let slot = &mut self.calls[index];
                if let Some(id) = tc.id.filter(|i| !i.is_empty()) {
                    slot.0 = id;
                }
                if let Some(f) = tc.function {
                    if let Some(name) = f.name.filter(|n| !n.is_empty()) {
                        let announce = slot.1.is_empty();
                        slot.1.push_str(&name);
                        if announce {
                            out.push(Delta::ToolCall {
                                index: index as u32,
                                name: slot.1.clone(),
                            });
                        }
                    }
                    if let Some(args) = f.arguments {
                        slot.2.push_str(&args);
                    }
                }
            }
            if let Some(reason) = choice.finish_reason {
                self.finish = Some(reason);
            }
        }
        if let Some(u) = chunk.usage {
            let usage = self.usage.get_or_insert_with(Usage::default);
            usage.prompt_tokens = u.prompt_tokens;
            usage.completion_tokens = u.completion_tokens;
        }
        if let Some(t) = chunk.timings {
            self.timings = Some(Timings {
                prompt_tokens_per_second: t.prompt_per_second.unwrap_or(0.0),
                generation_tokens_per_second: t.predicted_per_second.unwrap_or(0.0),
                prompt_ms: t.prompt_ms.unwrap_or(0.0),
                generation_ms: t.predicted_ms.unwrap_or(0.0),
            });
            let usage = self.usage.get_or_insert_with(Usage::default);
            if let Some(n) = t.cache_n {
                usage.cached_tokens = n;
            }
            if usage.prompt_tokens == 0 {
                usage.prompt_tokens = t.prompt_n.unwrap_or(0) + t.cache_n.unwrap_or(0);
            }
            if usage.completion_tokens == 0 {
                usage.completion_tokens = t.predicted_n.unwrap_or(0);
            }
        }
        Ok(out)
    }

    pub fn finish(self, cancelled: bool) -> ChatResult {
        let tool_calls: Vec<ToolCall> = self
            .calls
            .into_iter()
            .enumerate()
            .filter(|(_, (_, name, _))| !name.is_empty())
            .map(|(i, (id, name, arguments))| ToolCall {
                id: if id.is_empty() { format!("call_{i}") } else { id },
                kind: "function".into(),
                function: FunctionCall {
                    name,
                    arguments: if arguments.trim().is_empty() { "{}".into() } else { arguments },
                },
            })
            .collect();
        let finish_reason = if cancelled {
            FinishReason::Cancelled
        } else {
            match self.finish.as_deref() {
                Some("stop") | Some("eos") => FinishReason::Stop,
                Some("length") => FinishReason::Length,
                Some("tool_calls") | Some("function_call") => FinishReason::ToolCalls,
                _ if !tool_calls.is_empty() => FinishReason::ToolCalls,
                None => FinishReason::Stop,
                _ => FinishReason::Other,
            }
        };
        ChatResult {
            message: ChatMessage {
                role: MessageRole::Assistant,
                content: (!self.content.is_empty()).then_some(self.content),
                reasoning_content: (!self.reasoning.is_empty()).then_some(self.reasoning),
                tool_calls,
                tool_call_id: None,
                images: Vec::new(),
            },
            finish_reason,
            usage: self.usage,
            timings: self.timings,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_handles_arbitrary_chunking() {
        let raw = b"data: {\"a\":1}\r\n\r\n: keep-alive\n\ndata: {\"b\":\ndata: 2}\n\ndata: [DONE]\n\n";
        for split in 1..raw.len() {
            let mut p = SseParser::default();
            let mut events = p.feed(&raw[..split]);
            events.extend(p.feed(&raw[split..]));
            assert_eq!(events, vec!["{\"a\":1}", "{\"b\":\n2}", "[DONE]"], "split at {split}");
        }
    }

    #[test]
    fn sse_parser_flushes_unterminated_event() {
        let mut p = SseParser::default();
        assert!(p.feed(b"data: tail").is_empty());
        assert_eq!(p.finish().as_deref(), Some("tail"));
    }

    #[test]
    fn accumulates_content_reasoning_and_usage() {
        let mut acc = Accumulator::default();
        acc.apply(r#"{"choices":[{"delta":{"reasoning_content":"hmm"}}]}"#).unwrap();
        let d = acc.apply(r#"{"choices":[{"delta":{"content":"Hel"}}]}"#).unwrap();
        assert_eq!(d, vec![Delta::Content { text: "Hel".into() }]);
        acc.apply(r#"{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}"#).unwrap();
        acc.apply(r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2},"timings":{"cache_n":8,"predicted_per_second":55.5,"prompt_per_second":900.0}}"#).unwrap();
        let r = acc.finish(false);
        assert_eq!(r.message.content.as_deref(), Some("Hello"));
        assert_eq!(r.message.reasoning_content.as_deref(), Some("hmm"));
        assert_eq!(r.finish_reason, FinishReason::Stop);
        let u = r.usage.unwrap();
        assert_eq!((u.prompt_tokens, u.completion_tokens, u.cached_tokens), (10, 2, 8));
        assert_eq!(r.timings.unwrap().generation_tokens_per_second, 55.5);
    }

    #[test]
    fn assembles_parallel_streamed_tool_calls() {
        let mut acc = Accumulator::default();
        let chunks = [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"list_dir","arguments":"{}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.rs\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        ];
        let mut announced = Vec::new();
        for c in chunks {
            announced.extend(acc.apply(c).unwrap());
        }
        assert_eq!(announced.len(), 2);
        let r = acc.finish(false);
        assert_eq!(r.finish_reason, FinishReason::ToolCalls);
        assert_eq!(r.message.tool_calls.len(), 2);
        assert_eq!(r.message.tool_calls[0].function.name, "read_file");
        assert_eq!(r.message.tool_calls[0].function.arguments, r#"{"path":"a.rs"}"#);
        assert_eq!(r.message.tool_calls[1].id, "c2");
    }

    #[test]
    fn tool_call_without_id_or_arguments_gets_defaults() {
        let mut acc = Accumulator::default();
        acc.apply(r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"finish"}}]}}]}"#).unwrap();
        let r = acc.finish(false);
        assert_eq!(r.message.tool_calls[0].id, "call_0");
        assert_eq!(r.message.tool_calls[0].function.arguments, "{}");
        assert_eq!(r.finish_reason, FinishReason::ToolCalls);
    }

    #[test]
    fn non_streaming_message_is_supported() {
        let mut acc = Accumulator::default();
        acc.apply(r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"length"}]}"#).unwrap();
        let r = acc.finish(false);
        assert_eq!(r.message.content.as_deref(), Some("ok"));
        assert_eq!(r.finish_reason, FinishReason::Length);
    }

    #[test]
    fn request_serialization_omits_empty_fields() {
        let req = ChatRequest::new(vec![ChatMessage::user("hi")]);
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["stream"], true);
        assert!(v.get("tools").is_none());
        assert!(v.get("temperature").is_none());
        let mut with_extra = ChatRequest::new(vec![ChatMessage::user("hi")]);
        with_extra.extra.insert("reasoning_budget_tokens".into(), serde_json::json!(2048));
        let v = serde_json::to_value(&with_extra).unwrap();
        assert_eq!(v["reasoning_budget_tokens"], 2048, "extra fields are flattened into the body");
        assert_eq!(v["messages"][0]["role"], "user");
        assert!(v["messages"][0].get("tool_calls").is_none());
        let mut assistant = ChatMessage::assistant("x");
        assistant.reasoning_content = Some("secret thoughts".into());
        let v = serde_json::to_value(&assistant).unwrap();
        assert!(v.get("reasoning_content").is_none(), "reasoning is never sent back");
    }

    #[test]
    fn images_go_out_as_content_parts() {
        let png = crate::image::data_url(crate::image::ImageFormat::Png, &crate::image::tests::png_header(2, 3));
        let req = ChatRequest::new(vec![
            ChatMessage::system("You see images."),
            ChatMessage::user("What is on the screenshot?").with_images(vec![png.clone()]),
            ChatMessage::tool_result("call_1", "Image docs/ui.png (2x3 PNG):").with_images(vec![png.clone()]),
            ChatMessage::user("").with_images(vec![png.clone(), png.clone()]),
        ]);
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["messages"][0]["content"], "You see images.", "text alone stays a string");
        assert_eq!(
            v["messages"][1]["content"],
            serde_json::json!([
                {"type": "image_url", "image_url": {"url": png}},
                {"type": "text", "text": "What is on the screenshot?"}
            ])
        );
        assert_eq!(v["messages"][1]["role"], "user");
        assert_eq!(v["messages"][2]["tool_call_id"], "call_1");
        assert_eq!(v["messages"][2]["content"][0]["type"], "image_url");
        assert_eq!(v["messages"][2]["content"][1]["text"], "Image docs/ui.png (2x3 PNG):");
        assert_eq!(v["messages"][3]["content"].as_array().unwrap().len(), 2, "no empty text part");
        // Results read back (stored runs) have no images; nothing else changes.
        let back: ChatMessage = serde_json::from_value(serde_json::to_value(ChatMessage::assistant("ok")).unwrap()).unwrap();
        assert_eq!(back, ChatMessage::assistant("ok"));
    }
}
