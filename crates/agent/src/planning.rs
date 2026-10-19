//! Planning mode: the orchestrator only reads the project and writes a plan
//! the user reviews, changes in conversation or edits by hand, before the
//! agents carry it out ([`crate::orchestrator::run_plan`]). The plan's steps
//! become the run's tasks with the same ids, so a run that stopped for
//! planning and goes on keeps its numbering, and done tasks stay done.
//!
//! Everything a model sends is checked and bounded here; ids of steps the
//! model kept are kept, every other step gets a fresh number.

use crate::protocol::{Task, TaskStatus};
use crate::questions::{self, Question, QuestionLevel};
use crate::runner::PlanDraft;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanStep {
    /// "T1", "T2", ...: stays while the plan changes and becomes the task id.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// How to check the step is done.
    #[serde(default)]
    pub verify: String,
    #[serde(default = "default_assignee")]
    pub assignee: String,
}

fn default_assignee() -> String {
    "coder".into()
}

/// The plan of planning mode, as the user sees and edits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanDoc {
    pub goal: String,
    pub approach: String,
    pub steps: Vec<PlanStep>,
    #[serde(default)]
    pub risks: Vec<String>,
    /// Choices only the user can make, with answers to click.
    #[serde(default)]
    pub questions: Vec<Question>,
}

/// What the orchestrator is to plan: a new request, or a change to a plan.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanRequest {
    pub goal: String,
    /// The plan to change, with the user's own edits.
    pub current: Option<PlanDoc>,
    /// The user's wish for the change.
    pub wish: Option<String>,
    /// Earlier wishes about this plan, oldest first.
    pub earlier_wishes: Vec<String>,
}

pub const MAX_STEPS: usize = 12;
pub const MAX_RISKS: usize = 6;
const TITLE_CHARS: usize = 160;
const DESCRIPTION_CHARS: usize = 2_000;
const VERIFY_CHARS: usize = 400;
const RISK_CHARS: usize = 300;
const APPROACH_CHARS: usize = 1_500;
const MAX_FILES: usize = 12;
const MAX_WISHES: usize = 6;
const WISH_CHARS: usize = 1_000;
/// Upper bound of the current plan in the request.
const CURRENT_CHARS: usize = 6_000;

/// The plan from the orchestrator's `submit_plan`. With `current`, steps
/// that keep one of its ids keep it, and so does a step without a known id
/// whose title is unchanged; all other steps are numbered after
/// `first_number` (the last task number of the run the plan continues) and
/// after every id in use. `roles` are the roles that may work on a step.
pub fn doc_from_draft(goal: &str, draft: PlanDraft, current: Option<&PlanDoc>, first_number: usize, level: QuestionLevel, roles: &[String]) -> PlanDoc {
    let known: HashSet<&str> = current.map(|c| c.steps.iter().map(|s| s.id.as_str()).collect()).unwrap_or_default();
    let mut used: HashSet<String> = HashSet::new();
    let mut ids: Vec<Option<String>> = Vec::new();
    for task in draft.tasks.iter().take(MAX_STEPS) {
        let id = normalize_id(&task.id).filter(|id| known.contains(id.as_str()) && !used.contains(id));
        if let Some(id) = &id {
            used.insert(id.clone());
        }
        ids.push(id);
    }
    // Real models often send a kept step without its id: the same title is the same step.
    for (task, id) in draft.tasks.iter().zip(ids.iter_mut()).filter(|(_, id)| id.is_none()) {
        let title = title_key(&task.title);
        if let Some(step) = current.iter().flat_map(|c| c.steps.iter()).find(|s| !title.is_empty() && !used.contains(&s.id) && title_key(&s.title) == title) {
            used.insert(step.id.clone());
            *id = Some(step.id.clone());
        }
    }
    let highest = current.iter().flat_map(|c| c.steps.iter()).map(|s| number(&s.id)).chain(used.iter().map(|id| number(id))).max().unwrap_or(0);
    let mut next = highest.max(first_number);
    let steps = draft
        .tasks
        .into_iter()
        .take(MAX_STEPS)
        .zip(ids)
        .map(|(t, id)| {
            let id = id.unwrap_or_else(|| {
                next += 1;
                format!("T{next}")
            });
            let assignee = t.assignee.filter(|a| roles.contains(a) && a != "orchestrator" && a != "reviewer").unwrap_or_else(default_assignee);
            PlanStep {
                id,
                title: cut(&one_line(&t.title), TITLE_CHARS),
                description: cut(t.description.trim(), DESCRIPTION_CHARS),
                files: t.files.into_iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).take(MAX_FILES).collect(),
                verify: cut(t.verify.trim(), VERIFY_CHARS),
                assignee,
            }
        })
        .filter(|s| !s.title.is_empty())
        .collect();
    let questions = if level == QuestionLevel::Never { Vec::new() } else { questions::parse_clarify(&json!({ "questions": draft.questions })) };
    PlanDoc {
        goal: goal.to_string(),
        approach: cut(draft.summary.trim(), APPROACH_CHARS),
        steps,
        risks: risks(&draft.risks),
        questions,
    }
}

/// "T3" for "T3", "t3", " T3 ", "[T3]" (as the plan shows it), "#T3", "T-3"
/// and "3"; None for anything else.
fn normalize_id(id: &str) -> Option<String> {
    let id = id.trim().trim_start_matches(['[', '(', '#']).trim_end_matches([']', ')', ':', '.']).trim();
    let digits = id.strip_prefix(['T', 't']).unwrap_or(id).trim_start_matches([' ', '-', '_']);
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then(|| format!("T{}", digits.trim_start_matches('0')))
}

fn title_key(title: &str) -> String {
    one_line(title).to_lowercase()
}

fn number(id: &str) -> usize {
    id.strip_prefix('T').and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn risks(v: &Value) -> Vec<String> {
    let items: Vec<String> = match v {
        Value::Array(items) => items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect(),
        Value::String(s) => s.lines().map(str::to_string).collect(),
        _ => Vec::new(),
    };
    items
        .iter()
        .map(|r| one_line(r.trim().trim_start_matches(['-', '*', '•']).trim()))
        .filter(|r| !r.is_empty())
        .map(|r| cut(&r, RISK_CHARS))
        .take(MAX_RISKS)
        .collect()
}

/// The plan's steps as the run's tasks: same ids, open, with how to verify
/// in the description.
pub fn tasks(doc: &PlanDoc) -> Vec<Task> {
    doc.steps
        .iter()
        .map(|s| Task {
            id: s.id.clone(),
            title: s.title.clone(),
            description: match s.verify.trim() {
                "" => s.description.clone(),
                verify => format!("{}\n\nHow to verify: {verify}", s.description.trim()).trim().to_string(),
            },
            files: s.files.clone(),
            assignee: s.assignee.clone(),
            status: TaskStatus::Pending,
            attempts: 0,
            result: None,
            review: None,
        })
        .collect()
}

/// The fields of the planning template that depend on the request: the
/// current plan and the user's wish when the plan is to change, and the
/// rule for open questions.
pub fn sections(req: &PlanRequest, level: QuestionLevel) -> BTreeMap<&'static str, String> {
    let mut v = BTreeMap::new();
    let current = match (&req.current, &req.wish) {
        (Some(doc), wish) => {
            let mut s = format!("Current plan (it may contain the user's own edits):\n{}\n", describe(doc));
            let earlier: Vec<&String> = req.earlier_wishes.iter().rev().take(MAX_WISHES).collect::<Vec<_>>().into_iter().rev().collect();
            if !earlier.is_empty() {
                s.push_str("Earlier wishes of the user:\n");
                for w in earlier {
                    s.push_str(&format!("- {}\n", cut(&one_line(w), 300)));
                }
            }
            if let Some(wish) = wish.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
                s.push_str(&format!("The user's new wish:\n{}\n", cut(wish, WISH_CHARS)));
            }
            s.push_str("Change the plan as asked and keep the rest. Send every step you keep with its id in `id` (for example \"id\": \"T2\"), also when you change its text; new steps get no id. Read files again only when the change needs it.\n\n");
            s
        }
        (None, _) => String::new(),
    };
    v.insert("current", current);
    v.insert(
        "open_questions",
        match level {
            QuestionLevel::Never => "Add no open questions: decide yourself and name your assumptions in the approach.",
            QuestionLevel::IfNeeded => "Add open questions (at most 3, each with 2-4 short answers) only for important choices the project cannot answer; none when everything is clear.",
            QuestionLevel::Often => "Add open questions (at most 3, each with 2-4 short answers) for the choices that change the result.",
        }
        .to_string(),
    );
    v
}

/// The plan as text for the orchestrator, bounded.
pub fn describe(doc: &PlanDoc) -> String {
    let mut s = String::new();
    if !doc.approach.trim().is_empty() {
        s.push_str(&format!("Approach: {}\n", one_line(&doc.approach)));
    }
    s.push_str("Steps:\n");
    for step in &doc.steps {
        let mut line = format!("- [{}] {}\n", step.id, one_line(&step.title));
        if !step.description.trim().is_empty() {
            line.push_str(&format!("  What: {}\n", cut(&one_line(&step.description), 500)));
        }
        if !step.files.is_empty() {
            line.push_str(&format!("  Files: {}\n", step.files.join(", ")));
        }
        if !step.verify.trim().is_empty() {
            line.push_str(&format!("  Verify: {}\n", one_line(&step.verify)));
        }
        if s.chars().count() + line.chars().count() > CURRENT_CHARS {
            s.push_str("- …\n");
            break;
        }
        s.push_str(&line);
    }
    if !doc.risks.is_empty() {
        s.push_str("Risks:\n");
        for r in &doc.risks {
            s.push_str(&format!("- {r}\n"));
        }
    }
    if !doc.questions.is_empty() {
        s.push_str("Open questions:\n");
        for q in &doc.questions {
            s.push_str(&format!("- {}\n", questions::as_text(q).replace('\n', " ")));
        }
    }
    s
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::TaskDraft;

    fn draft(tasks: &[(&str, &str)]) -> PlanDraft {
        PlanDraft {
            summary: " Fix it, then test it. ".into(),
            tasks: tasks
                .iter()
                .map(|(id, title)| TaskDraft {
                    title: title.to_string(),
                    description: format!("Do {title}."),
                    files: vec!["src/cart.ts".into(), " ".into()],
                    assignee: None,
                    id: id.to_string(),
                    verify: "npm test".into(),
                })
                .collect(),
            risks: json!(["- Rounding of cents", "", 42]),
            questions: json!([{ "question": "Which runner?", "options": ["Vitest (recommended)", "Jest"] }, { "question": "" }]),
        }
    }

    fn ids(doc: &PlanDoc) -> Vec<&str> {
        doc.steps.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn a_new_plan_is_numbered_and_bounded() {
        let roles = vec!["coder".to_string()];
        let doc = doc_from_draft("Fix the cart", draft(&[("T9", "Fix total()"), ("", "Add a test")]), None, 0, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&doc), vec!["T1", "T2"], "ids the model makes up for a new plan are not kept");
        assert_eq!(doc.approach, "Fix it, then test it.");
        assert_eq!(doc.steps[0].files, vec!["src/cart.ts"]);
        assert_eq!(doc.steps[0].verify, "npm test");
        assert_eq!(doc.risks, vec!["Rounding of cents"]);
        assert_eq!(doc.questions.len(), 1);
        assert!(doc.questions[0].options[0].recommended);
        // After a run that stopped at T4, new steps go on from there.
        let doc = doc_from_draft("Go on", draft(&[("", "More")]), None, 4, QuestionLevel::Never, &roles);
        assert_eq!(ids(&doc), vec!["T5"]);
        assert!(doc.questions.is_empty(), "no questions when the user wants none");
        let many: Vec<(&str, &str)> = (0..20).map(|_| ("", "Step")).collect();
        assert_eq!(doc_from_draft("x", draft(&many), None, 0, QuestionLevel::IfNeeded, &roles).steps.len(), MAX_STEPS);
    }

    #[test]
    fn a_changed_plan_keeps_the_ids_of_the_steps_it_kept() {
        let roles = vec!["coder".to_string()];
        let current = doc_from_draft("Fix the cart", draft(&[("", "Fix total()"), ("", "Add a test"), ("", "Docs")]), None, 2, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&current), vec!["T3", "T4", "T5"]);
        // Step T4 dropped, T5 kept (lower case), a new step, a duplicate and an unknown id.
        let changed = doc_from_draft("Fix the cart", draft(&[("T3", "Fix total() with cents"), ("", "Check rounding"), ("t5", "Docs"), ("T3", "Again"), ("T1", "Old id")]), Some(&current), 2, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&changed), vec!["T3", "T6", "T5", "T7", "T8"]);
        assert_eq!(changed.steps[0].title, "Fix total() with cents");
    }

    #[test]
    fn a_kept_step_keeps_its_id_when_the_model_writes_it_differently_or_leaves_it_out() {
        let roles = vec!["coder".to_string()];
        let current = doc_from_draft("Fix the cart", draft(&[("", "Fix total()"), ("", "Add a test"), ("", "Docs"), ("", "Release notes")]), None, 0, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&current), vec!["T1", "T2", "T3", "T4"]);
        // As Qwen3.6 35B did it: every step again without ids, one more at the end.
        let changed = doc_from_draft("Fix the cart", draft(&[("", "Fix total()"), ("", " add  a TEST "), ("", "Docs"), ("", "Release notes"), ("", "Export it")]), Some(&current), 0, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&changed), vec!["T1", "T2", "T3", "T4", "T5"]);
        // Ids as the plan shows them, plain numbers, and a renamed step without an id.
        let changed = doc_from_draft("Fix the cart", draft(&[("[T2]", "Add a Vitest test"), ("1", "Fix total() and cents"), ("#T3", "Docs"), ("", "Notes for the release")]), Some(&current), 0, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&changed), vec!["T2", "T1", "T3", "T5"]);
        let changed = doc_from_draft("Fix the cart", draft(&[("", "Docs"), ("T3", "Docs v2")]), Some(&current), 0, QuestionLevel::IfNeeded, &roles);
        assert_eq!(ids(&changed), vec!["T5", "T3"], "an id the model sent wins over a title");
    }

    #[test]
    fn steps_become_tasks_with_how_to_verify() {
        let roles = vec!["coder".to_string(), "tester".to_string()];
        let mut d = draft(&[("", "Fix total()")]);
        d.tasks[0].assignee = Some("tester".into());
        let doc = doc_from_draft("Fix", d, None, 0, QuestionLevel::IfNeeded, &roles);
        let tasks = tasks(&doc);
        assert_eq!(tasks[0].id, "T1");
        assert_eq!(tasks[0].assignee, "tester");
        assert_eq!(tasks[0].description, "Do Fix total().\n\nHow to verify: npm test");
        assert_eq!(tasks[0].status, TaskStatus::Pending);
        let mut d = draft(&[("", "x")]);
        d.tasks[0].assignee = Some("reviewer".into());
        assert_eq!(doc_from_draft("x", d, None, 0, QuestionLevel::IfNeeded, &roles).steps[0].assignee, "coder");
    }

    #[test]
    fn the_request_names_the_current_plan_and_the_wish() {
        let roles = vec!["coder".to_string()];
        let doc = doc_from_draft("Fix the cart", draft(&[("", "Fix total()"), ("", "Add a test")]), None, 0, QuestionLevel::IfNeeded, &roles);
        let fresh = sections(&PlanRequest { goal: "Fix the cart".into(), ..Default::default() }, QuestionLevel::IfNeeded);
        assert_eq!(fresh["current"], "");
        assert!(fresh["open_questions"].contains("only for important choices"));
        let req = PlanRequest {
            goal: "Fix the cart".into(),
            current: Some(doc),
            wish: Some("Ändere Schritt 2, nimm lieber Vitest".into()),
            earlier_wishes: vec!["Kürzer bitte".into()],
        };
        let s = sections(&req, QuestionLevel::Often);
        let current = &s["current"];
        assert!(current.contains("- [T1] Fix total()\n  What: Do Fix total().\n  Files: src/cart.ts\n  Verify: npm test\n"), "{current}");
        assert!(current.contains("Earlier wishes of the user:\n- Kürzer bitte\n"), "{current}");
        assert!(current.contains("The user's new wish:\nÄndere Schritt 2, nimm lieber Vitest\n"), "{current}");
        assert!(current.contains("Send every step you keep with its id in `id` (for example \"id\": \"T2\")"), "{current}");
        assert!(current.contains("Open questions:\n- Which runner? Options: Vitest (recommended) / Jest"), "{current}");
        assert!(s["open_questions"].contains("choices that change the result"));
    }

    #[test]
    fn plans_read_back_from_the_app_tolerate_missing_fields() {
        let doc: PlanDoc = serde_json::from_str(r#"{"goal":"g","approach":"a","steps":[{"id":"T1","title":"t"}]}"#).unwrap();
        assert_eq!(doc.steps[0].assignee, "coder");
        assert!(doc.risks.is_empty() && doc.questions.is_empty());
    }
}
