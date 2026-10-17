//! The model abstraction agents run on. Production uses a llama-server slot via
//! the scheduler; tests use [`ScriptedModel`].

use async_trait::async_trait;
use inference::{ChatRequest, ChatResult, Delta, LlmClient, LlmError, Priority, Scheduler};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait ChatModel: Send + Sync {
    async fn chat(
        &self,
        req: ChatRequest,
        cancel: &CancellationToken,
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<ChatResult, LlmError>;

    /// Context window available to one request (tokens).
    fn context_tokens(&self) -> u32;

    /// The model sees images (its vision projector is loaded): messages may
    /// carry them, and agents get the `image_view` tool.
    fn vision(&self) -> bool {
        false
    }
}

/// A model served by llama-server (or any OpenAI-compatible endpoint), sharing
/// slots through the scheduler. `preferred_slot` keeps an agent on the same slot
/// so its prompt prefix stays in the KV cache.
pub struct ScheduledModel {
    pub client: LlmClient,
    pub scheduler: Scheduler,
    pub priority: Priority,
    pub preferred_slot: Option<usize>,
    pub label: String,
    pub context_tokens: u32,
    /// Send `id_slot` (llama-server only; other servers reject unknown fields rarely, but we stay clean).
    pub pin_slot: bool,
}

#[async_trait]
impl ChatModel for ScheduledModel {
    async fn chat(
        &self,
        mut req: ChatRequest,
        cancel: &CancellationToken,
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<ChatResult, LlmError> {
        let guard = tokio::select! {
            g = self.scheduler.acquire(self.priority, self.preferred_slot, self.label.clone()) => g,
            _ = cancel.cancelled() => return Ok(inference::openai::Accumulator::default().finish(true)),
        };
        if self.pin_slot {
            req.id_slot = Some(guard.slot() as i32);
        }
        let result = self.client.chat(req, cancel, on_delta).await;
        drop(guard);
        result
    }

    fn context_tokens(&self) -> u32 {
        self.context_tokens
    }
}

/// Replays canned responses and records requests (tests, demos).
pub struct ScriptedModel {
    responses: Mutex<std::collections::VecDeque<ChatResult>>,
    pub requests: Mutex<Vec<ChatRequest>>,
    context: u32,
    vision: bool,
}

impl ScriptedModel {
    pub fn new(responses: Vec<ChatResult>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::new(Vec::new()),
            context: 32_768,
            vision: false,
        }
    }

    /// A model that sees images.
    pub fn with_vision(mut self) -> Self {
        self.vision = true;
        self
    }

    pub fn remaining(&self) -> usize {
        self.responses.lock().unwrap().len()
    }
}

#[async_trait]
impl ChatModel for ScriptedModel {
    async fn chat(
        &self,
        req: ChatRequest,
        cancel: &CancellationToken,
        on_delta: &mut (dyn FnMut(Delta) + Send),
    ) -> Result<ChatResult, LlmError> {
        self.requests.lock().unwrap().push(req);
        if cancel.is_cancelled() {
            return Ok(inference::openai::Accumulator::default().finish(true));
        }
        let next = self.responses.lock().unwrap().pop_front();
        match next {
            Some(r) => {
                if let Some(c) = &r.message.content {
                    on_delta(Delta::Content { text: c.clone() });
                }
                Ok(r)
            }
            None => Err(LlmError::Protocol("scripted model ran out of responses".into())),
        }
    }

    fn context_tokens(&self) -> u32 {
        self.context
    }

    fn vision(&self) -> bool {
        self.vision
    }
}

/// Helpers to build scripted responses.
pub mod script {
    use inference::{ChatMessage, ChatResult, FinishReason, FunctionCall, MessageRole, ToolCall, Usage};
    use serde_json::Value;

    pub fn text(content: &str) -> ChatResult {
        ChatResult {
            message: ChatMessage::assistant(content),
            finish_reason: FinishReason::Stop,
            usage: Some(Usage {
                prompt_tokens: 100,
                completion_tokens: 10,
                cached_tokens: 0,
            }),
            timings: None,
        }
    }

    pub fn call(name: &str, args: Value) -> ChatResult {
        calls(&[(name, args)])
    }

    pub fn calls(list: &[(&str, Value)]) -> ChatResult {
        ChatResult {
            message: ChatMessage {
                role: MessageRole::Assistant,
                content: None,
                reasoning_content: None,
                tool_calls: list
                    .iter()
                    .enumerate()
                    .map(|(i, (name, args))| ToolCall {
                        id: format!("call_{i}_{name}"),
                        kind: "function".into(),
                        function: FunctionCall {
                            name: name.to_string(),
                            arguments: args.to_string(),
                        },
                    })
                    .collect(),
                tool_call_id: None,
                images: Vec::new(),
            },
            finish_reason: FinishReason::ToolCalls,
            usage: Some(Usage {
                prompt_tokens: 100,
                completion_tokens: 20,
                cached_tokens: 0,
            }),
            timings: None,
        }
    }
}
