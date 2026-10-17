//! The summary a run ends with, written by the orchestrator for the user in
//! the user's language: what was done and why, which files changed, how to try
//! it, and what is still open. It is built only from what the run recorded
//! (plan, task results, reviews, changed files, commands that worked), with a
//! bound on every part so small local contexts fit. When the model call fails,
//! times out, runs out of tokens or answers with a plan or a tool call, the UI
//! shows the plain task list instead; a stopped run gets no summary call at all.

use crate::protocol::{NO_VERDICT, Plan, TaskStatus, Verdict};
use crate::runner::{PlanDraft, parse_json_object};
use inference::FinishReason;
use std::collections::BTreeMap;
use std::time::Duration;

/// System message of the summary call. Not the orchestrator's prompt: that
/// one asks for a plan, and small models then answer with plan JSON.
pub const SYSTEM: &str = "You write a short report about a finished coding run for the user. You have no tools: answer in plain text only.";
/// The model call is given up after this long; the task list stands in.
pub const TIMEOUT: Duration = Duration::from_secs(180);
/// Token budget of the answer. The call asks the model not to think (chat
/// defaults); the room is for models that think anyway. The text is capped
/// at `MAX_CHARS` after that.
pub const MAX_TOKENS: u32 = 2_500;
/// Characters kept of the model's answer.
pub const MAX_CHARS: usize = 4_000;
/// Upper bound for the task list the summary is written from.
const TASKS_CHARS: usize = 5_000;
const GOAL_CHARS: usize = 600;
const APPROACH_CHARS: usize = 400;
const COMMAND_CHARS: usize = 200;
const TITLE_CHARS: usize = 100;
const RESULT_CHARS: usize = 300;
const REVIEW_CHARS: usize = 160;
const MAX_FILES: usize = 30;
const MAX_COMMANDS: usize = 8;

/// English name of an app language, for the prompt; English for codes it does not know.
pub fn language_name(code: &str) -> &'static str {
    let base = code.split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase();
    match base.as_str() {
        "de" => "German",
        "es" => "Spanish",
        "fr" => "French",
        "hi" => "Hindi",
        "id" => "Indonesian",
        "ja" => "Japanese",
        "ko" => "Korean",
        "pt" => "Brazilian Portuguese",
        "ru" => "Russian",
        "zh" => "Simplified Chinese",
        _ => "English",
    }
}

/// The fields of the summary template: `language`, `goal`, `approach`,
/// `tasks`, `files`, `commands`. Of the commands the last ones are kept: the
/// build and test runs at the end matter most.
pub fn values(goal: &str, plan: Option<&Plan>, files: &[String], commands: &[String], language: &str) -> BTreeMap<&'static str, String> {
    let mut v = BTreeMap::new();
    v.insert("language", language_name(language).to_string());
    v.insert("goal", one_line(goal, GOAL_CHARS));
    let approach = plan.map(|p| one_line(&p.summary, APPROACH_CHARS)).filter(|a| !a.is_empty());
    v.insert("approach", approach.unwrap_or_else(|| "(none)".into()));
    v.insert("tasks", tasks(plan));
    v.insert("files", listing(files, MAX_FILES));
    let recent: Vec<String> = commands[commands.len().saturating_sub(MAX_COMMANDS)..]
        .iter()
        .map(|c| one_line(c.lines().next().unwrap_or_default(), COMMAND_CHARS))
        .collect();
    v.insert("commands", listing(&recent, MAX_COMMANDS));
    v
}

fn tasks(plan: Option<&Plan>) -> String {
    let Some(plan) = plan.filter(|p| !p.tasks.is_empty()) else { return "(no plan was made)".into() };
    let mut out = String::new();
    for (i, t) in plan.tasks.iter().enumerate() {
        let status = match t.status {
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Skipped => "skipped",
            TaskStatus::Pending => "not started",
            TaskStatus::InProgress | TaskStatus::InReview => "unfinished",
        };
        let mut line = format!("- {} {} ({status})", t.id, one_line(&t.title, TITLE_CHARS));
        if let Some(r) = t.result.as_deref().map(|r| one_line(r, RESULT_CHARS)).filter(|r| !r.is_empty()) {
            line.push_str(&format!(": {r}"));
        }
        if let Some(review) = &t.review {
            let verdict = match review.verdict {
                // Accepted without a verdict: the reviewer never finished.
                _ if review.summary.starts_with(NO_VERDICT) => "not done",
                Verdict::Approve => "approved",
                Verdict::RequestChanges => "still had open comments",
            };
            line.push_str(&format!(" Review: {verdict}"));
            let summary = one_line(&review.summary, REVIEW_CHARS);
            if !summary.is_empty() {
                line.push_str(&format!(" ({summary})"));
            }
            line.push('.');
        }
        line.push('\n');
        if out.chars().count() + line.chars().count() > TASKS_CHARS {
            out.push_str(&format!("- … and {} more tasks\n", plan.tasks.len() - i));
            break;
        }
        out.push_str(&line);
    }
    out.trim_end().to_string()
}

fn listing(items: &[String], max: usize) -> String {
    if items.is_empty() {
        return "(none)".into();
    }
    let mut out = items.iter().take(max).map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n");
    if items.len() > max {
        out.push_str(&format!("\n- … and {} more", items.len() - max));
    }
    out
}

/// The summary from a model's answer, or None when it is no summary: cut
/// off by the token limit, empty, or a plan or tool call instead of text.
pub fn from_answer(content: &str, finish: FinishReason) -> Option<String> {
    if finish == FinishReason::Length || is_call_or_plan(content) {
        return None;
    }
    clean(content)
}

/// Small models given a coding role sometimes answer with a tool call or a
/// plan in JSON; that is no summary.
fn is_call_or_plan(text: &str) -> bool {
    let names: Vec<&str> = crate::tools::all_tools().iter().map(|t| t.name).collect();
    let (calls, _) = crate::textcalls::parse_text_tool_calls(text, &names);
    !calls.is_empty() || parse_json_object::<PlanDraft>(text).is_some()
}

/// The summary from a model's answer: a code fence wrapped around all of it
/// (plain, markdown or text) removed, cut at a line end after `MAX_CHARS`.
/// None when nothing is left.
pub fn clean(answer: &str) -> Option<String> {
    let text = unwrap_fence(answer.trim());
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_CHARS {
        return Some(text.to_string());
    }
    let cut = text.char_indices().nth(MAX_CHARS).map_or(text.len(), |(i, _)| i);
    let kept = text[..cut].rfind('\n').map_or(&text[..cut], |nl| &text[..nl]);
    Some(format!("{}\n…", kept.trim_end()))
}

/// The inside of a fence around the whole text. Only a plain, markdown or
/// text fence counts, and only when the fences inside it pair up: two
/// separate code blocks are no wrapper.
fn unwrap_fence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else { return text };
    let Some((info, body)) = rest.split_once('\n') else { return text };
    let Some(inner) = body.trim_end().strip_suffix("```") else { return text };
    let wrapper = matches!(info.trim().to_ascii_lowercase().as_str(), "" | "markdown" | "md" | "text");
    let inner_fences = inner.lines().filter(|l| l.trim_start().starts_with("```")).count();
    if wrapper && inner_fences % 2 == 0 { inner.trim() } else { text }
}

/// Whitespace collapsed to single spaces, cut to `max` characters.
fn one_line(text: &str, max: usize) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > max { format!("{}…", joined.chars().take(max).collect::<String>()) } else { joined }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Review, Task};

    fn task(id: &str, status: TaskStatus, result: Option<&str>, review: Option<(Verdict, &str)>) -> Task {
        Task {
            id: id.into(),
            title: format!("Task {id}"),
            description: String::new(),
            files: vec![],
            assignee: "coder".into(),
            status,
            attempts: 0,
            result: result.map(Into::into),
            review: review.map(|(verdict, summary)| Review { verdict, summary: summary.into(), comments: vec![] }),
        }
    }

    fn plan(tasks: Vec<Task>) -> Plan {
        Plan { goal: "g".into(), summary: "s".into(), tasks }
    }

    #[test]
    fn every_app_language_has_a_name() {
        for (code, name) in [
            ("en", "English"),
            ("de", "German"),
            ("es", "Spanish"),
            ("fr", "French"),
            ("hi", "Hindi"),
            ("id", "Indonesian"),
            ("ja", "Japanese"),
            ("ko", "Korean"),
            ("pt", "Brazilian Portuguese"),
            ("ru", "Russian"),
            ("zh", "Simplified Chinese"),
            ("de-AT", "German"),
            ("pt_BR", "Brazilian Portuguese"),
            ("xx", "English"),
            ("", "English"),
        ] {
            assert_eq!(language_name(code), name, "{code}");
        }
    }

    #[test]
    fn the_input_holds_tasks_reviews_files_and_commands() {
        let p = plan(vec![
            task("T1", TaskStatus::Done, Some("Fixed total()\nin src/cart.ts."), Some((Verdict::Approve, "Looks right."))),
            task("T2", TaskStatus::Failed, Some("Stopped: step limit reached."), None),
            task("T3", TaskStatus::Done, Some("Added a test."), Some((Verdict::RequestChanges, "Edge case missing."))),
            task("T4", TaskStatus::Pending, None, None),
        ]);
        let v = values("Fix the cart", Some(&p), &["src/cart.ts".into()], &["npm test".into()], "de");
        assert_eq!(v["language"], "German");
        assert_eq!(v["goal"], "Fix the cart");
        let tasks = &v["tasks"];
        assert!(tasks.contains("- T1 Task T1 (done): Fixed total() in src/cart.ts. Review: approved (Looks right.)."), "{tasks}");
        assert!(tasks.contains("- T2 Task T2 (failed): Stopped: step limit reached.\n"), "{tasks}");
        assert!(tasks.contains("Review: still had open comments (Edge case missing.)."), "{tasks}");
        assert!(tasks.ends_with("- T4 Task T4 (not started)"), "{tasks}");
        assert_eq!(v["approach"], "s");
        assert_eq!(v["files"], "- src/cart.ts");
        assert_eq!(v["commands"], "- npm test");
        assert_eq!(values("x", None, &[], &[], "en")["approach"], "(none)");
    }

    #[test]
    fn a_review_that_never_happened_is_not_an_approval() {
        let summary = format!("{NO_VERDICT} (step limit); accepted without review.");
        let p = plan(vec![task("T1", TaskStatus::Done, Some("Done."), Some((Verdict::Approve, &summary)))]);
        let tasks = &values("x", Some(&p), &[], &[], "en")["tasks"];
        assert!(tasks.contains("Review: not done (Reviewer did not submit a verdict (step limit); accepted without review.)."), "{tasks}");
        assert!(!tasks.contains("approved"), "{tasks}");
    }

    #[test]
    fn the_last_commands_are_kept_on_one_line_each() {
        let mut commands: Vec<String> = (0..12).map(|i| format!("step {i}")).collect();
        commands.push(format!("npm run build -- --verbose\nsecond line {}", "x".repeat(300)));
        commands.push(format!("npm test {}", "y".repeat(300)));
        let v = values("x", None, &[], &commands, "en");
        let lines: Vec<&str> = v["commands"].lines().collect();
        assert_eq!(lines.len(), MAX_COMMANDS);
        assert_eq!(lines[0], "- step 6", "the first ones are dropped");
        assert_eq!(lines[MAX_COMMANDS - 2], "- npm run build -- --verbose");
        assert!(lines[MAX_COMMANDS - 1].starts_with("- npm test yyy"));
        assert_eq!(lines[MAX_COMMANDS - 1].chars().count(), 2 + COMMAND_CHARS + 1);
    }

    #[test]
    fn the_input_is_bounded() {
        let long = "word ".repeat(500);
        let p = plan((1..=40).map(|i| task(&format!("T{i}"), TaskStatus::Done, Some(&long), Some((Verdict::Approve, &long)))).collect());
        let files: Vec<String> = (0..50).map(|i| format!("src/f{i}.rs")).collect();
        let commands: Vec<String> = (0..20).map(|i| format!("cmd {i}")).collect();
        let v = values(&long, Some(&p), &files, &commands, "en");
        assert!(v["tasks"].chars().count() <= TASKS_CHARS + 40, "{}", v["tasks"].chars().count());
        assert!(v["tasks"].contains("more tasks"));
        assert!(v["goal"].chars().count() <= GOAL_CHARS + 1);
        assert_eq!(v["files"].lines().count(), MAX_FILES + 1);
        assert!(v["files"].ends_with("- … and 20 more"));
        assert_eq!(v["commands"].lines().count(), MAX_COMMANDS, "only the last commands");
        let total: usize = v.values().map(|s| s.chars().count()).sum();
        assert!(total < 8_000, "{total}");
    }

    #[test]
    fn without_a_plan_or_files_the_input_says_so() {
        let v = values("x", None, &[], &[], "fr");
        assert_eq!(v["language"], "French");
        assert_eq!(v["tasks"], "(no plan was made)");
        assert_eq!(v["files"], "(none)");
        assert_eq!(v["commands"], "(none)");
    }

    #[test]
    fn answers_are_cleaned_and_capped() {
        assert_eq!(clean("  \n "), None);
        assert_eq!(clean("```markdown\nDone: total() works.\n```").as_deref(), Some("Done: total() works."));
        assert_eq!(clean("```\nDone.\n```").as_deref(), Some("Done."));
        assert_eq!(clean("Fixed `total()`.\n\n```sh\nnpm test\n```").as_deref(), Some("Fixed `total()`.\n\n```sh\nnpm test\n```"));
        let long: String = (0..800).map(|i| format!("line {i}\n")).collect();
        let capped = clean(&long).unwrap();
        assert!(capped.chars().count() <= MAX_CHARS + 2, "{}", capped.chars().count());
        assert!(capped.ends_with("\n…"));
    }

    #[test]
    fn separate_code_blocks_are_no_wrapper() {
        let two = "```sh\nnpm test\n```\n\nTests pass.\n\n```sh\nnpm run build\n```";
        assert_eq!(clean(two).as_deref(), Some(two));
        let wrapped = "```markdown\nDone. Try it:\n\n```sh\nnpm test\n```\n```";
        assert_eq!(clean(wrapped).as_deref(), Some("Done. Try it:\n\n```sh\nnpm test\n```"));
        let one_block = "```sh\nnpm test\n```";
        assert_eq!(clean(one_block).as_deref(), Some(one_block), "a single sh block stays a code block");
    }

    #[test]
    fn cut_off_answers_plans_and_tool_calls_are_no_summary() {
        let text = "- `total()` rechnet jetzt richtig.";
        assert_eq!(from_answer(text, FinishReason::Stop).as_deref(), Some(text));
        assert_eq!(from_answer("- `total()` rechnet jetzt ri", FinishReason::Length), None);
        assert_eq!(from_answer("", FinishReason::Stop), None);
        let plan = r#"{"summary": "Fix the cart", "tasks": [{"title": "Fix", "description": "Fix total()"}]}"#;
        assert_eq!(from_answer(plan, FinishReason::Stop), None);
        assert_eq!(from_answer("<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/cart.ts\"}}\n</tool_call>", FinishReason::Stop), None);
        assert_eq!(from_answer("I will now call submit_plan.\n```json\n{\"name\": \"submit_plan\", \"arguments\": {\"summary\": \"x\", \"tasks\": []}}\n```", FinishReason::Stop), None);
        let with_json = "Done. The config now reads `{\"port\": 8080}`.";
        assert_eq!(from_answer(with_json, FinishReason::Stop).as_deref(), Some(with_json), "JSON that is no plan is fine");
    }
}
