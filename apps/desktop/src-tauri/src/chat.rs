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
use skills::EnabledSkill;
use skills::prompt::Audience;
use workspace::{ContextItem, ContextKind, Mention};

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
    /// Images of a user message as data URLs (scaled down by the UI).
    #[serde(default)]
    pub images: Vec<String>,
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

/// The chat's system prompt: the setting, the open project's name, its
/// AGENTS.md (the user's rules and what the agents noted), bounded, and the
/// skills section.
fn system_prompt(base: &str, ws: Option<&workspace::Workspace>, skills: &str) -> String {
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
    if !skills.is_empty() {
        system.push_str("\n\n");
        system.push_str(skills);
    }
    system
}

/// The skills part of the chat's system prompt: the list of enabled skills,
/// then the text of each one the user mentioned as @name anywhere in the
/// conversation (the chat has no tools to read them). It sits in the system
/// prompt, so it stays put in later turns and the server's cache still fits.
/// Returns it with a chip for each attached skill.
fn skills_section<'a>(enabled: &[EnabledSkill], user_texts: impl IntoIterator<Item = &'a str>, model_context: u32) -> (String, Vec<ContextItem>) {
    if enabled.is_empty() {
        return (String::new(), vec![]);
    }
    let mut text = skills::prompt::listing(enabled, Audience::Chat).trim_end().to_string();
    let mut chips = Vec::new();
    let budget = skills::prompt::read_budget(model_context);
    for skill in skills::prompt::mentioned(user_texts, enabled).into_iter().take(skills::prompt::MAX_ATTACHED) {
        let chip = |content: String, truncated: bool, error: Option<String>| ContextItem {
            kind: ContextKind::Skill,
            label: format!("@{}", skill.name),
            path: None,
            tokens: workspace::context::estimate_tokens(&content),
            content,
            truncated,
            error,
        };
        match skills::prompt::attachment(skill, budget) {
            Ok((section, truncated)) => {
                text.push_str("\n\n");
                text.push_str(&section);
                chips.push(chip(section, truncated, None));
            }
            Err(e) => chips.push(chip(String::new(), false, Some(e.to_string()))),
        }
    }
    (text, chips)
}

/// Images of a request, checked: only a model with its vision projector
/// loaded takes them, and each must be an image llama.cpp reads.
pub fn check_images(images: &[String], vision: bool) -> AppResult<()> {
    if images.is_empty() {
        return Ok(());
    }
    if !vision {
        return Err(AppError::new("no_vision", "the model that is running cannot see images"));
    }
    for url in images {
        inference::image::check_data_url(url).map_err(|e| AppError::new("bad_image", e))?;
    }
    Ok(())
}

/// Earlier images when the running model cannot see: the turn keeps a note
/// in their place, so a chat with images can go on with any model.
fn history_message(role: UiRole, content: &str, images: &[String], vision: bool) -> ChatMessage {
    match role {
        UiRole::Assistant => ChatMessage::assistant(content),
        UiRole::User if vision || images.is_empty() => ChatMessage::user(content).with_images(images.to_vec()),
        UiRole::User => ChatMessage::user(format!("{content}\n\n[{} image(s) left out: the current model cannot see images]", images.len())),
    }
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
    check_images(&last.images, h.vision)?;
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
    let enabled = crate::skill_service::enabled(&state.skills, ws.as_ref());
    let user_texts = req.messages.iter().filter(|m| m.role == UiRole::User).map(|m| m.content.as_str());
    let (skill_prompt, skill_chips) = skills_section(&enabled, user_texts, h.context);
    let _ = channel.send(ChatEvent::Context { items: items.iter().cloned().chain(skill_chips).collect() });

    let mut messages = vec![ChatMessage::system(system_prompt(&settings.chat.system_prompt, ws.as_ref(), &skill_prompt))];
    for m in history {
        // Sent before: already checked, and sent the same way again for the KV cache.
        messages.push(history_message(m.role, &m.content, &m.images, h.vision));
    }
    let context: Vec<String> = items.iter().filter(|i| i.error.is_none()).map(|i| i.content.clone()).collect();
    let final_user = if context.is_empty() {
        last.content.clone()
    } else {
        format!("{}\n\n{}", context.join("\n\n"), last.content)
    };
    messages.push(ChatMessage::user(final_user).with_images(last.images.clone()));

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
    fn images_need_a_model_that_sees() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8Dwn4GBgYEBAB/+BP2hkTGKAAAAAElFTkSuQmCC".to_string();
        assert!(check_images(&[], false).is_ok());
        assert!(check_images(std::slice::from_ref(&png), true).is_ok());
        assert_eq!(check_images(std::slice::from_ref(&png), false).unwrap_err().code, "no_vision");
        assert_eq!(check_images(&["data:text/html;base64,PGh0bWw+".into()], true).unwrap_err().code, "bad_image");

        // A user turn with images, sent again: as parts while the model sees, else with a note.
        let seen = history_message(UiRole::User, "What is this?", std::slice::from_ref(&png), true);
        assert_eq!(seen.images, vec![png.clone()]);
        let blind = history_message(UiRole::User, "What is this?", &[png.clone(), png], false);
        assert!(blind.images.is_empty());
        assert_eq!(blind.content.as_deref(), Some("What is this?\n\n[2 image(s) left out: the current model cannot see images]"));
        assert_eq!(history_message(UiRole::Assistant, "A cat.", &[], false), ChatMessage::assistant("A cat."));
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
        let without = system_prompt("Be brief.", Some(&ws), "");
        assert!(without.starts_with("Be brief.\n\nThe open project is") && !without.contains("AGENTS.md"), "{without}");
        std::fs::write(dir.join("AGENTS.md"), format!("Always use pnpm.\n{}", "x\n".repeat(5_000))).unwrap();
        let with = system_prompt("Be brief.", Some(&ws), "");
        assert!(with.contains("Project notes from AGENTS.md") && with.contains("Always use pnpm."), "{with}");
        assert!(with.contains("the rest was left out"), "bounded");
        assert!(with.len() < "Be brief.".len() + CHAT_NOTES_CHARS + 1_000);
        assert_eq!(system_prompt("Be brief.", None, ""), "Be brief.");
    }

    #[test]
    fn the_chat_lists_skills_and_attaches_the_mentioned_ones() {
        let dir = std::env::temp_dir().join(format!("chat-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let skill = |name: &str, body: &str| {
            let folder = dir.join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("SKILL.md"), format!("---\nname: {name}\ndescription: About {name}.\n---\n{body}")).unwrap();
            EnabledSkill { name: name.into(), description: format!("About {name}."), dir: folder }
        };
        let enabled = vec![skill("pdf", "Use qpdf.\n"), skill("long", &"Step.\n".repeat(10_000))];
        assert_eq!(skills_section(&[], ["@pdf"], 32_768), (String::new(), vec![]));

        let (listed, chips) = skills_section(&enabled, ["How do I fill a form?"], 32_768);
        assert!(listed.contains("- pdf: About pdf.") && listed.contains("@pdf") && !listed.contains("Use qpdf."), "{listed}");
        assert!(chips.is_empty());

        let (text, chips) = skills_section(&enabled, ["Fill it with @pdf", "and @long, again @pdf"], 8_192);
        assert!(text.contains("attached by the user with @pdf") && text.contains("Use qpdf."), "{text}");
        assert!(text.contains("[The skill goes on; the rest was left out to save context.]"), "the long one is cut");
        assert!(text.len() < 2 * skills::prompt::read_budget(8_192) + 4_000, "{} characters", text.len());
        let labels: Vec<(&str, bool)> = chips.iter().map(|c| (c.label.as_str(), c.truncated)).collect();
        assert_eq!(labels, vec![("@pdf", false), ("@long", true)]);
        assert!(chips.iter().all(|c| c.kind == ContextKind::Skill && c.error.is_none() && c.tokens > 0));
        let prompt = system_prompt("Be brief.", None, &text);
        assert!(prompt.starts_with("Be brief.\n\nSkills the user enabled"), "{prompt}");
    }
}
