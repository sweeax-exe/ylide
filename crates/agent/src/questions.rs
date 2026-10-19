//! Questions for the user with answers to click: an agent's `ask` with
//! options, and the orchestrator's single round of questions before it plans
//! (`clarify`). Everything a model sends is checked and cut to size here, so
//! a small model's malformed call ends as a plain question or as no question
//! at all, never as a broken card.

use crate::recap::language_name;
use crate::tools::ToolSpec;
use inference::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

/// The orchestrator's tool for its questions before the plan. No role lists
/// it: the orchestrator gets it while it plans, unless questions are off.
pub const CLARIFY: &str = "clarify";

/// How readily agents and the chat ask back (setting "Rückfragen").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum QuestionLevel {
    /// No questions before the plan; the chat answers with the likeliest reading.
    Never,
    /// Only when a request is really ambiguous.
    #[default]
    IfNeeded,
    /// Also when a request leaves a choice open that changes the result.
    Often,
}

/// One answer the user can click.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AnswerOption {
    pub label: String,
    /// The asking agent recommends it (at most one per question).
    #[serde(default)]
    pub recommended: bool,
}

/// A question for the user, as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Question {
    pub question: String,
    /// 2-4 answers to click; empty for a question answered in free text.
    #[serde(default)]
    pub options: Vec<AnswerOption>,
    /// Several options may be picked together.
    #[serde(default)]
    pub multiple: bool,
}

impl Question {
    pub fn plain(question: impl Into<String>) -> Self {
        Self {
            question: question.into(),
            options: Vec::new(),
            multiple: false,
        }
    }
}

/// Questions in one round before the plan.
pub const MAX_QUESTIONS: usize = 3;
/// Answers to click per question (and at least `MIN_OPTIONS`, or none).
pub const MAX_OPTIONS: usize = 4;
const MIN_OPTIONS: usize = 2;
/// Characters of a question and of an answer to click.
pub const QUESTION_CHARS: usize = 300;
pub const OPTION_CHARS: usize = 80;

/// What a model writes after an option it recommends, in the app languages.
const RECOMMENDED: &[&str] = &[
    "recommended",
    "empfohlen",
    "recomendado",
    "recomendada",
    "recommandé",
    "recommandée",
    "recommande",
    "disarankan",
    "direkomendasikan",
    "अनुशंसित",
    "おすすめ",
    "推奨",
    "추천",
    "권장",
    "рекомендуется",
    "рекомендую",
    "推荐",
    "建议",
];

/// The question of an `ask` call, or None without question text.
pub fn parse_ask(args: &Value) -> Option<Question> {
    question_from(args)
}

/// The questions of a `clarify` call (also of a reply that only has the
/// JSON), checked and cut to `MAX_QUESTIONS`; empty when none is usable.
pub fn parse_clarify(args: &Value) -> Vec<Question> {
    let list: Vec<Value> = match args.get("questions") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(items)) => items,
            _ => s.lines().map(|l| Value::String(l.to_string())).collect(),
        },
        Some(other @ Value::Object(_)) => vec![other.clone()],
        _ if args.get("question").is_some() => vec![args.clone()],
        _ => Vec::new(),
    };
    let mut out: Vec<Question> = Vec::new();
    for q in list.iter().filter_map(question_from) {
        if !out.iter().any(|o| o.question.to_lowercase() == q.question.to_lowercase()) {
            out.push(q);
        }
        if out.len() == MAX_QUESTIONS {
            break;
        }
    }
    out
}

fn question_from(v: &Value) -> Option<Question> {
    let (text, options, multiple, hint) = match v {
        Value::String(s) => (s.as_str(), None, false, None),
        Value::Object(o) => {
            let text = ["question", "text", "q", "title", "prompt"].iter().find_map(|k| o.get(*k).and_then(Value::as_str))?;
            let options = ["options", "choices", "answers"].iter().find_map(|k| o.get(*k));
            let multiple = ["multiple", "multi", "multi_select", "multiSelect", "allow_multiple"].iter().find_map(|k| o.get(*k)).is_some_and(truthy);
            (text, options, multiple, o.get("recommended").and_then(Value::as_str))
        }
        _ => return None,
    };
    let question = cut(&strip_bullet(text.trim()), QUESTION_CHARS);
    if question.is_empty() {
        return None;
    }
    let options = options.map(|o| parse_options(o, hint)).unwrap_or_default();
    let multiple = multiple && !options.is_empty();
    Some(Question { question, options, multiple })
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "1"),
        Value::Number(n) => n.as_i64() == Some(1),
        _ => false,
    }
}

/// Answers to click: 2-4 distinct labels, at most one recommended; none when
/// fewer than two are usable (the question is then answered in free text).
fn parse_options(v: &Value, recommended: Option<&str>) -> Vec<AnswerOption> {
    let items: Vec<Value> = match v {
        Value::Array(items) => items.clone(),
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(items)) => items,
            _ => {
                let sep = if s.contains('\n') { '\n' } else { '|' };
                s.split(sep).map(|p| Value::String(p.to_string())).collect()
            }
        },
        _ => Vec::new(),
    };
    let hint = recommended.map(|r| label(r).0.to_lowercase());
    let mut out: Vec<AnswerOption> = Vec::new();
    for item in &items {
        let Some(mut option) = option_from(item) else { continue };
        if hint.as_deref() == Some(option.label.to_lowercase().as_str()) {
            option.recommended = true;
        }
        if out.iter().any(|o| o.label.to_lowercase() == option.label.to_lowercase()) {
            continue;
        }
        out.push(option);
        if out.len() == MAX_OPTIONS {
            break;
        }
    }
    if out.len() < MIN_OPTIONS {
        return Vec::new();
    }
    let mut seen = false;
    for o in out.iter_mut().filter(|o| o.recommended) {
        o.recommended = !seen;
        seen = true;
    }
    out
}

fn option_from(v: &Value) -> Option<AnswerOption> {
    let (text, flagged) = match v {
        Value::String(s) => (s.clone(), false),
        Value::Number(n) => (n.to_string(), false),
        Value::Object(o) => {
            let text = ["label", "text", "option", "value", "answer", "title"].iter().find_map(|k| o.get(*k).and_then(Value::as_str))?;
            (text.to_string(), o.get("recommended").is_some_and(truthy))
        }
        _ => return None,
    };
    let (label, marked) = label(&text);
    let label = cut(&label, OPTION_CHARS);
    (!label.is_empty()).then_some(AnswerOption { label, recommended: flagged || marked })
}

/// The label without bullet, quotes and a trailing "(recommended)" marker,
/// on one line; and whether the marker was there.
fn label(text: &str) -> (String, bool) {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s = strip_bullet(&one_line);
    let mut marked = false;
    for (open, close) in [('(', ')'), ('[', ']'), ('（', '）'), ('【', '】')] {
        if let Some(body) = s.strip_suffix(close)
            && let Some(at) = body.rfind(open)
        {
            let inner = body[at + open.len_utf8()..].trim().trim_end_matches(['!', '.']).to_lowercase();
            if RECOMMENDED.contains(&inner.as_str()) {
                s = body[..at].trim_end().trim_end_matches([',', '-', '–', '—', ':']).trim_end().to_string();
                marked = true;
                break;
            }
        }
    }
    let unquoted = s.trim_matches(|c| matches!(c, '"' | '\'' | '`' | '“' | '”' | '„' | '«' | '»')).trim();
    (unquoted.to_string(), marked)
}

fn strip_bullet(text: &str) -> String {
    let t = text.trim();
    t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("• ")).unwrap_or(t).trim().to_string()
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
}

/// A question as text for an agent (or the message log): the question with
/// its options, the recommended one marked.
pub fn as_text(q: &Question) -> String {
    if q.options.is_empty() {
        return q.question.clone();
    }
    let options: Vec<String> = q.options.iter().map(|o| if o.recommended { format!("{} (recommended)", o.label) } else { o.label.clone() }).collect();
    format!("{}\nOptions: {}", q.question, options.join(" / "))
}

/// Several questions as text, numbered.
pub fn list_text(questions: &[Question]) -> String {
    match questions {
        [one] => as_text(one),
        _ => questions.iter().enumerate().map(|(i, q)| format!("{}. {}", i + 1, as_text(q))).collect::<Vec<_>>().join("\n"),
    }
}

/// What a model is told when the user left a question open.
pub const LEFT_OPEN: &str = "(no answer: decide yourself and say what you assumed)";
/// ... and when the user skipped all of them.
pub const ALL_SKIPPED: &str = "The user skipped the questions. Decide yourself with sensible defaults and say in your answer what you assumed.";

/// The user's answers as the model reads them: the answer itself for one
/// question, each question with its answer for several. Missing or empty
/// answers become a note to decide alone.
pub fn format_reply(questions: &[Question], answers: &[String]) -> String {
    let answer = |i: usize| answers.get(i).map(|a| a.trim()).filter(|a| !a.is_empty());
    if (0..questions.len().max(1)).all(|i| answer(i).is_none()) {
        return ALL_SKIPPED.into();
    }
    if questions.len() <= 1 {
        return answer(0).unwrap_or(LEFT_OPEN).to_string();
    }
    questions
        .iter()
        .enumerate()
        .map(|(i, q)| format!("{}. {}\nAnswer: {}", i + 1, q.question, answer(i).unwrap_or(LEFT_OPEN)))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(crate) fn clarify_spec() -> ToolSpec {
    ToolSpec {
        name: CLARIFY,
        risk: crate::permissions::ToolRisk::Communicate,
        description: CLARIFY_WHEN_NEEDED,
        parameters: json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_QUESTIONS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "description": "One short question." },
                            "options": { "type": "array", "maxItems": MAX_OPTIONS, "items": { "type": "string" }, "description": "2-4 short answers to click, when there are clear choices." },
                            "multiple": { "type": "boolean", "description": "The user may pick several options." }
                        },
                        "required": ["question"]
                    }
                }
            },
            "required": ["questions"]
        }),
    }
}

const CLARIFY_WHEN_NEEDED: &str = "Ask the user up to 3 short questions before you plan; you can do this once per run. Only when the request is ambiguous or leaves an important choice open that the project cannot answer: which framework or library, the scope, the behaviour, or the name of a public API. Never ask what you can find in the project, in AGENTS.md or in the previous run, and never for a clear or small request: then call submit_plan right away.";
const CLARIFY_OFTEN: &str = "Ask the user up to 3 short questions before you plan; you can do this once per run. Ask when the request leaves choices open that change the result: which framework or library, the scope, the behaviour, the name of a public API, or what to do in edge cases. Never ask what you can find in the project, in AGENTS.md or in the previous run, and skip it for a small request whose meaning is clear.";
const OPTIONS_HINT: &str = "Give a question 2-4 short answers in options when there are clear choices; put the one you recommend first and end it with ' (recommended)'. The user can always write their own answer.";

/// A tool's definition for a run: `clarify` worded for the level, and the
/// tools that ask the user told the user's language.
pub fn tool_definition(spec: &ToolSpec, level: QuestionLevel, language: &str) -> ToolDefinition {
    let lang = language_name(language);
    match spec.name {
        CLARIFY => {
            let when = if level == QuestionLevel::Often { CLARIFY_OFTEN } else { CLARIFY_WHEN_NEEDED };
            let text = format!("{when} {OPTIONS_HINT} Write the questions and answers in {lang}. You get the user's answers back; then plan with them and call submit_plan.");
            ToolDefinition::function(spec.name, &text, spec.parameters.clone())
        }
        "ask" => ToolDefinition::function(spec.name, &format!("{} Write questions for the user in {lang}.", spec.description), spec.parameters.clone()),
        _ => spec.definition(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(q: &Question) -> Vec<(&str, bool)> {
        q.options.iter().map(|o| (o.label.as_str(), o.recommended)).collect()
    }

    #[test]
    fn ask_takes_options_and_marks_the_recommended_one() {
        let q = parse_ask(&json!({"to": "user", "question": "Which test runner?", "options": ["Vitest (recommended)", "Jest", "  "], "multiple": "false"})).unwrap();
        assert_eq!(q.question, "Which test runner?");
        assert_eq!(labels(&q), vec![("Vitest", true), ("Jest", false)]);
        assert!(!q.multiple);

        // Objects, a field naming the recommended one, localized markers, duplicates.
        let q = parse_ask(&json!({"question": "Wo?", "options": [{"label": "Oben"}, {"text": "Unten", "recommended": true}, "oben", "Links [empfohlen]"], "multiple": true})).unwrap();
        assert_eq!(labels(&q), vec![("Oben", false), ("Unten", true), ("Links", false)], "one recommended at most, the first");
        assert!(q.multiple);
        let q = parse_ask(&json!({"question": "Q", "options": ["A", "B"], "recommended": "b"})).unwrap();
        assert_eq!(labels(&q), vec![("A", false), ("B", true)]);
        let q = parse_ask(&json!({"question": "哪个?", "options": "[\"React（推荐）\", \"Vue\"]"})).unwrap();
        assert_eq!(labels(&q), vec![("React", true), ("Vue", false)], "an array sent as a string");
        let q = parse_ask(&json!({"question": "Q", "options": "- Yes\n- No (Recommended)"})).unwrap();
        assert_eq!(labels(&q), vec![("Yes", false), ("No", true)], "one per line");
    }

    #[test]
    fn options_are_bounded_or_dropped() {
        let long = "x".repeat(200);
        let q = parse_ask(&json!({"question": "Q", "options": ["a", "b", "c", "d", "e", long]})).unwrap();
        assert_eq!(q.options.len(), MAX_OPTIONS);
        let q = parse_ask(&json!({"question": "Q", "options": [long.clone(), "b"]})).unwrap();
        assert_eq!(q.options[0].label.chars().count(), OPTION_CHARS);
        assert!(q.options[0].label.ends_with('…'));
        // Fewer than two usable answers: a free-text question, never `multiple`.
        let q = parse_ask(&json!({"question": "Q", "options": ["only", "ONLY", ""], "multiple": true})).unwrap();
        assert!(q.options.is_empty() && !q.multiple);
        let q = parse_ask(&json!({"question": "Q", "options": 42})).unwrap();
        assert!(q.options.is_empty());
        // Plain questions keep working.
        assert_eq!(parse_ask(&json!({"to": "user", "question": "Tabs or spaces?"})), Some(Question::plain("Tabs or spaces?")));
        assert_eq!(parse_ask(&json!({"to": "user", "question": "  "})), None);
        assert_eq!(parse_ask(&json!({"to": "user"})), None);
        let q = parse_ask(&json!({"question": "y".repeat(500)})).unwrap();
        assert_eq!(q.question.chars().count(), QUESTION_CHARS);
    }

    #[test]
    fn clarify_keeps_at_most_three_usable_questions() {
        let qs = parse_clarify(&json!({"questions": [
            {"question": "Which framework?", "options": ["React (recommended)", "Svelte"]},
            "Should it work offline?",
            {"question": ""},
            {"text": "which framework?"},
            {"question": "Name of the hook?"},
            {"question": "One too many?"}
        ]}));
        assert_eq!(qs.iter().map(|q| q.question.as_str()).collect::<Vec<_>>(), vec!["Which framework?", "Should it work offline?", "Name of the hook?"]);
        assert_eq!(labels(&qs[0]), vec![("React", true), ("Svelte", false)]);
        // A single question without the list, and a list sent as a string.
        assert_eq!(parse_clarify(&json!({"question": "Scope?"})), vec![Question::plain("Scope?")]);
        assert_eq!(parse_clarify(&json!({"questions": "[\"A?\", \"B?\"]"})).len(), 2);
        assert_eq!(parse_clarify(&json!({"questions": "Only one?"})), vec![Question::plain("Only one?")]);
    }

    #[test]
    fn clarify_garbage_gives_no_questions() {
        for garbage in [json!({}), json!({"questions": []}), json!({"questions": [1, null, {"options": ["a", "b"]}]}), json!("text"), json!({"questions": {"nope": true}})] {
            assert!(parse_clarify(&garbage).is_empty(), "{garbage}");
        }
    }

    #[test]
    fn replies_name_each_question_and_what_was_left_open() {
        let one = [Question::plain("Tabs?")];
        assert_eq!(format_reply(&one, &["Tabs".into()]), "Tabs");
        assert_eq!(format_reply(&one, &["  ".into()]), ALL_SKIPPED);
        assert_eq!(format_reply(&[], &[]), ALL_SKIPPED);
        let two = [Question::plain("Framework?"), Question::plain("Offline?")];
        assert_eq!(format_reply(&two, &["React".into()]), format!("1. Framework?\nAnswer: React\n\n2. Offline?\nAnswer: {LEFT_OPEN}"));
        assert_eq!(format_reply(&two, &[String::new(), String::new()]), ALL_SKIPPED);
    }

    #[test]
    fn questions_read_as_text_for_agents() {
        let q = parse_ask(&json!({"question": "Runner?", "options": ["Vitest (recommended)", "Jest"]})).unwrap();
        assert_eq!(as_text(&q), "Runner?\nOptions: Vitest (recommended) / Jest");
        assert_eq!(list_text(&[q.clone(), Question::plain("Name?")]), "1. Runner?\nOptions: Vitest (recommended) / Jest\n2. Name?");
        assert_eq!(list_text(std::slice::from_ref(&q)), as_text(&q));
    }

    #[test]
    fn tool_wording_follows_level_and_language() {
        let spec = clarify_spec();
        let text = |level, lang: &str| tool_definition(&spec, level, lang).function.description;
        assert!(text(QuestionLevel::IfNeeded, "de").contains("never for a clear or small request") && text(QuestionLevel::IfNeeded, "de").contains("in German"));
        assert!(text(QuestionLevel::Often, "ja").contains("choices open that change the result") && text(QuestionLevel::Often, "ja").contains("in Japanese"));
        let ask = crate::tools::tool_spec("ask").unwrap();
        assert!(tool_definition(&ask, QuestionLevel::IfNeeded, "fr").function.description.ends_with("Write questions for the user in French."));
        let read = crate::tools::tool_spec("read_file").unwrap();
        assert_eq!(tool_definition(&read, QuestionLevel::Often, "de"), read.definition());
    }
}
