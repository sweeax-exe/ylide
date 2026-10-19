//! Local inference: runs llama.cpp's `llama-server`, talks to it (or any other
//! OpenAI-compatible endpoint the user configures) and schedules requests from
//! chat, inline edit and agents onto its parallel slots.

pub mod client;
pub mod image;
pub mod openai;
pub mod scheduler;
pub mod server;

pub use client::{BenchResult, Endpoint, Health, InfillExtra, LlmClient, LlmError};
pub use openai::{
    ChatMessage, ChatRequest, ChatResult, Delta, FinishReason, FunctionCall, MessageRole, SamplingParams, Timings,
    ToolCall, ToolDefinition, Usage,
};
pub use scheduler::{Priority, Scheduler, SchedulerSnapshot, SlotGuard};
pub use server::{LlamaServer, RuntimeDevice, ServerConfig, ServerError, ServerStatus, list_devices};

#[cfg(test)]
mod client_tests;
