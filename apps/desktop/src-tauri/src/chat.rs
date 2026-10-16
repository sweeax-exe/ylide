//! Chat with project context and inline edits.
//!
//! Context blocks (from @-mentions and the selection) are attached to the
//! newest user message only, so the earlier conversation stays byte-identical
//! and llama-server can reuse its KV cache for it.

use crate::error::{AppError, AppResult};
use crate::runtime::ChatHandle;
use crate::state::AppState;
use inference::{ChatMessage, ChatRequest, ChatResult, Delta, Priority};
use registry::{ModeDefaults, Model};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use ts_rs::TS;
use workspace::{ContextItem, Mention};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Agent,
    Chat,
    Inline,
}

/// Fills sampling and chat-template switches from the registry for `mode`,
/// without overriding values the caller already set.
pub fn apply_mode(req: &mut ChatRequest, model: Option<&Model>, mode: Mode) {
    let Some(defaults) = model.and_then(|m| m.request_defaults.as_ref()) else { return };
    let d: Option<&ModeDefaults> = match mode {
        Mode::Agent => defaults.agent.as_ref(),
        Mode::Chat => defaults.chat.as_ref(),
        Mode::Inline => defaults.inline.as_ref().or(defaults.chat.as_ref()),
    };
    let Some(d) = d else { return };
    req.temperature = req.temperature.or(d.temperature);
    req.top_p = req.top_p.or(d.top_p);
    req.top_k = req.top_k.or(d.top_k);
    req.min_p = req.min_p.or(d.min_p);
    req.presence_penalty = req.presence_penalty.or(d.presence_penalty);
    req.repeat_penalty = req.repeat_penalty.or(d.repeat_penalty);
    if req.chat_template_kwargs.is_none() {
        req.chat_template_kwargs = d.template_kwargs.clone();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum UiRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UiMessage {
    pub role: UiRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatSendRequest {
    pub id: String,
    /// Whole conversation; the last message is the new user message.
    pub messages: Vec<UiMessage>,
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum ChatEvent {
    /// The context that is sent with the message (shown as chips).
    Context { items: Vec<ContextItem> },
    Delta { delta: Delta },
    Done { result: ChatResult },
    Error { error: AppError },
}

async fn handle(state: &AppState) -> AppResult<ChatHandle> {
    state
        .runtime
        .chat_handle()
        .await
        .ok_or_else(|| AppError::new("no_model", "start a model first"))
}

/// Token budget for attached context: the user's limit, but at most half of
/// the model's context so the answer still has room. Used by `send` and by
/// the composer's preview, so both shorten items the same way.
pub fn context_budget(user_limit: u32, model_context: Option<u32>) -> u32 {
    match model_context {
        Some(c) => user_limit.min(c / 2),
        None => user_limit,
    }
}

/// Characters of the project's AGENTS.md in the chat's system prompt.
const CHAT_NOTES_CHARS: usize = 4_000;

/// The chat's system prompt: the setting, the open project's name and its
/// AGENTS.md (the user's rules and what the agents noted), bounded.
fn system_prompt(base: &str, ws: Option<&workspace::Workspace>) -> String {
    let mut system = base.to_string();
    if let Some(ws) = ws {
        system.push_str(&format!("\n\nThe open project is \"{}\".", ws.name()));
        if let Ok(file) = ws.read_text(agent::knowledge::FILE) {
            let notes = agent::knowledge::prompt_section(&file.content, CHAT_NOTES_CHARS);
            if !notes.is_empty() {
                system.push_str("\n\n");
                system.push_str(notes.trim_end());
            }
        }
    }
    system
}

/// Slot for interactive requests: the last one (agents prefer slot 0).
fn interactive_slot(h: &ChatHandle) -> Option<usize> {
    let n = h.scheduler.slot_count();
    (n > 1).then_some(n - 1)
}

pub async fn send(state: &AppState, req: ChatSendRequest, channel: Channel<ChatEvent>) -> AppResult<()> {
    let h = handle(state).await?;
    let settings = state.settings();
    let Some((last, history)) = req.messages.split_last() else {
        return Err(AppError::new("empty", "no message"));
    };
    let ws = state.workspace.read().unwrap().clone();
    let items = match (&ws, req.mentions.is_empty()) {
        (Some(ws), false) => {
            let ws = ws.clone();
            let mentions = req.mentions.clone();
            let budget = context_budget(settings.chat.context_budget_tokens, Some(h.context));
            tokio::task::spawn_blocking(move || workspace::resolve_mentions(&ws, &mentions, budget))
                .await
                .map_err(|e| AppError::new("internal", e))?
        }
        _ => vec![],
    };
    let _ = channel.send(ChatEvent::Context { items: items.clone() });

    let mut messages = vec![ChatMessage::system(system_prompt(&settings.chat.system_prompt, ws.as_ref()))];
    for m in history {
        messages.push(match m.role {
            UiRole::User => ChatMessage::user(m.content.clone()),
            UiRole::Assistant => ChatMessage::assistant(m.content.clone()),
        });
    }
    let context: Vec<String> = items.iter().filter(|i| i.error.is_none()).map(|i| i.content.clone()).collect();
    let final_user = if context.is_empty() {
        last.content.clone()
    } else {
        format!("{}\n\n{}", context.join("\n\n"), last.content)
    };
    messages.push(ChatMessage::user(final_user));

    let mut request = ChatRequest::new(messages);
    apply_mode(&mut request, h.model.as_ref(), Mode::Chat);
    let cancel = state.register_request(&req.id);
    let guard = h.scheduler.acquire(Priority::Interactive, interactive_slot(&h), "chat").await;
    if h.pin_slot {
        request.id_slot = Some(guard.slot() as i32);
    }
    let result = h
        .client
        .chat(request, &cancel, |delta| {
            let _ = channel.send(ChatEvent::Delta { delta });
        })
        .await;
    drop(guard);
    state.finish_request(&req.id);
    match result {
        Ok(result) => {
            let _ = channel.send(ChatEvent::Done { result });
            Ok(())
        }
        Err(e) => {
            let error: AppError = e.into();
            let _ = channel.send(ChatEvent::Error { error: error.clone() });
            Err(error)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InlineEditRequest {
    pub id: String,
    pub path: String,
    pub language: String,
    /// Full current text of the editor buffer (may contain unsaved changes).
    pub content: String,
    /// 1-based, inclusive. An empty selection inserts at `start_line`.
    pub start_line: u32,
    pub end_line: u32,
    pub instruction: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum InlineEvent {
    Delta { text: String },
    Done { replacement: String },
    Error { error: AppError },
}

const INLINE_CONTEXT_LINES: usize = 60;

/// Builds the user message for an inline edit.
pub fn inline_prompt(req: &InlineEditRequest) -> String {
    let lines: Vec<&str> = req.content.split('\n').collect();
    let start = (req.start_line.max(1) as usize - 1).min(lines.len());
    let end = (req.end_line as usize).clamp(start, lines.len());
    let before = &lines[start.saturating_sub(INLINE_CONTEXT_LINES)..start];
    let selection = &lines[start..end];
    let after = &lines[end..(end + INLINE_CONTEXT_LINES).min(lines.len())];
    let fence = |body: &str| format!("```{}\n{}\n```", req.language, body);
    let target = if selection.iter().all(|l| l.trim().is_empty()) {
        format!("Insert new code at line {} (between the code before and after).", req.start_line)
    } else {
        format!("Selected code (lines {}-{}), rewrite this part:\n{}", req.start_line, req.end_line, fence(&selection.join("\n")))
    };
    format!(
        "File: {} ({})\n\nCode before the selection (read-only):\n{}\n\n{}\n\nCode after the selection (read-only):\n{}\n\nInstruction: {}\n\nReply with the new code for the selection only.",
        req.path,
        req.language,
        fence(&before.join("\n")),
        target,
        fence(&after.join("\n")),
        req.instruction.trim()
    )
}

/// Removes Markdown fences and chatter the model added despite instructions.
pub fn clean_replacement(text: &str) -> String {
    let trimmed = text.trim_matches('\n');
    let t = trimmed.trim();
    if t.starts_with("```") {
        let after_open = t.find('\n').map(|i| &t[i + 1..]).unwrap_or("");
        let body = after_open.rfind("```").map(|i| &after_open[..i]).unwrap_or(after_open);
        return body.trim_end_matches(['\n', ' ']).to_string();
    }
    // A fenced block somewhere inside an explanation: take the first block.
    if let Some(open) = t.find("\n```") {
        let rest = &t[open + 4..];
        if let Some(nl) = rest.find('\n') {
            let body = &rest[nl + 1..];
            if let Some(close) = body.find("```") {
                return body[..close].trim_end_matches(['\n', ' ']).to_string();
            }
        }
    }
    trimmed.trim_end().to_string()
}

pub async fn inline(state: &AppState, req: InlineEditRequest, channel: Channel<InlineEvent>) -> AppResult<()> {
    let h = handle(state).await?;
    let settings = state.settings();
    let mut request = ChatRequest::new(vec![
        ChatMessage::system(settings.chat.inline_prompt.clone()),
        ChatMessage::user(inline_prompt(&req)),
    ]);
    apply_mode(&mut request, h.model.as_ref(), Mode::Inline);
    let cancel = state.register_request(&req.id);
    let guard = h.scheduler.acquire(Priority::Interactive, interactive_slot(&h), "inline edit").await;
    if h.pin_slot {
        request.id_slot = Some(guard.slot() as i32);
    }
    let result = h
        .client
        .chat(request, &cancel, |delta| {
            if let Delta::Content { text } = delta {
                let _ = channel.send(InlineEvent::Delta { text });
            }
        })
        .await;
    drop(guard);
    state.finish_request(&req.id);
    match result {
        Ok(r) => {
            let replacement = clean_replacement(r.message.content.as_deref().unwrap_or_default());
            let _ = channel.send(InlineEvent::Done { replacement });
            Ok(())
        }
        Err(e) => {
            let error: AppError = e.into();
            let _ = channel.send(InlineEvent::Error { error: error.clone() });
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_budget_leaves_half_of_the_model_context_for_the_answer() {
        assert_eq!(context_budget(24_000, Some(131_072)), 24_000);
        assert_eq!(context_budget(24_000, Some(16_384)), 8_192);
        assert_eq!(context_budget(24_000, None), 24_000, "no model: the preview uses the user's limit");
    }

    #[test]
    fn mode_defaults_fill_only_missing_values() {
        let reg = registry::bundled();
        let model = reg.models.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let mut req = ChatRequest::new(vec![]);
        apply_mode(&mut req, Some(model), Mode::Agent);
        assert_eq!(req.temperature, Some(0.6));
        assert_eq!(req.chat_template_kwargs, Some(serde_json::json!({"preserve_thinking": true})));
        let mut req = ChatRequest::new(vec![]);
        req.temperature = Some(0.1);
        apply_mode(&mut req, Some(model), Mode::Chat);
        assert_eq!(req.temperature, Some(0.1), "explicit values win");
        assert_eq!(req.chat_template_kwargs, Some(serde_json::json!({"enable_thinking": false})));
    }

    #[test]
    fn inline_prompt_contains_bounded_context() {
        let content = (1..=200).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let req = InlineEditRequest {
            id: "x".into(),
            path: "src/a.rs".into(),
            language: "rust".into(),
            content,
            start_line: 100,
            end_line: 102,
            instruction: "make it better".into(),
        };
        let p = inline_prompt(&req);
        assert!(p.contains("Selected code (lines 100-102)"));
        assert!(p.contains("line 100\nline 101\nline 102"));
        assert!(p.contains("line 40\n"), "60 lines before");
        assert!(!p.contains("line 39\n"));
        assert!(p.contains("line 162"));
        assert!(!p.contains("line 163"));
    }

    #[test]
    fn replacement_cleanup() {
        assert_eq!(clean_replacement("```rust\nfn a() {}\n```"), "fn a() {}");
        assert_eq!(clean_replacement("Here you go:\n```ts\nconst x = 1;\n```\nDone."), "const x = 1;");
        assert_eq!(clean_replacement("    indented();\n"), "    indented();", "indentation is preserved");
    }

    #[test]
    fn the_chat_knows_the_projects_agents_md() {
        let dir = std::env::temp_dir().join(format!("chat-notes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ws = workspace::Workspace::open(&dir).unwrap();
        let without = system_prompt("Be brief.", Some(&ws));
        assert!(without.starts_with("Be brief.\n\nThe open project is") && !without.contains("AGENTS.md"), "{without}");
        std::fs::write(dir.join("AGENTS.md"), format!("Always use pnpm.\n{}", "x\n".repeat(5_000))).unwrap();
        let with = system_prompt("Be brief.", Some(&ws));
        assert!(with.contains("Project notes from AGENTS.md") && with.contains("Always use pnpm."), "{with}");
        assert!(with.contains("the rest was left out"), "bounded");
        assert!(with.len() < "Be brief.".len() + CHAT_NOTES_CHARS + 1_000);
        assert_eq!(system_prompt("Be brief.", None), "Be brief.");
    }
}
