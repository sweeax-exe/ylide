//! Agent roles and prompt templates. Everything here is shown and editable in
//! the settings UI; the defaults live in `crates/agent/prompts/`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RoleDefinition {
    /// Stable id used in plans and `ask` ("orchestrator", "coder", "reviewer", or custom).
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    /// Tool names this role may use.
    pub tools: Vec<String>,
    /// Model to use (`None` = the main model). Registry id or endpoint name.
    pub model: Option<String>,
    /// Overrides the model's recommended temperature for this role.
    pub temperature: Option<f64>,
    /// Upper bound of model turns per task.
    pub max_steps: u32,
    /// Shipped with the app (can be edited and reset, not deleted).
    pub builtin: bool,
}

const READ_TOOLS: &[&str] = &["list_dir", "read_file", "search", "find_files"];

fn tools(extra: &[&str]) -> Vec<String> {
    READ_TOOLS.iter().chain(extra).map(|s| s.to_string()).collect()
}

pub fn default_roles() -> Vec<RoleDefinition> {
    vec![
        RoleDefinition {
            id: "orchestrator".into(),
            name: "Orchestrator".into(),
            description: "Understands the request, explores the project and plans small tasks.".into(),
            system_prompt: include_str!("../prompts/orchestrator.md").trim().into(),
            tools: tools(&["submit_plan"]),
            model: None,
            temperature: None,
            max_steps: 12,
            builtin: true,
        },
        RoleDefinition {
            id: "coder".into(),
            name: "Coder".into(),
            description: "Implements tasks: reads, edits and creates files, runs builds and tests.".into(),
            system_prompt: include_str!("../prompts/coder.md").trim().into(),
            tools: tools(&["write_file", "edit_file", "delete_file", "run_command", "ask", "finish"]),
            model: None,
            temperature: None,
            max_steps: 40,
            builtin: true,
        },
        RoleDefinition {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: "Reviews each task's diff, runs checks and requests changes when needed.".into(),
            system_prompt: include_str!("../prompts/reviewer.md").trim().into(),
            tools: tools(&["run_command", "ask", "submit_review"]),
            model: None,
            temperature: None,
            max_steps: 16,
            builtin: true,
        },
    ]
}

/// Message templates with `{placeholder}` fields; see `prompts/templates.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PromptTemplates {
    pub planner: String,
    pub coder_task: String,
    pub reviewer_task: String,
    pub feedback: String,
    pub question: String,
    #[serde(rename = "continue")]
    pub continue_: String,
    pub repeated_failure: String,
    /// Asks the orchestrator for the new project notes after a run. Settings
    /// saved before it existed get the default.
    #[serde(default = "default_notes")]
    pub notes: String,
}

fn default_notes() -> String {
    // The bundled file has the field, so this never recurses.
    PromptTemplates::default().notes
}

impl Default for PromptTemplates {
    fn default() -> Self {
        serde_json::from_str(include_str!("../prompts/templates.json")).expect("bundled templates are valid")
    }
}

/// Replaces `{key}` placeholders; unknown placeholders stay untouched.
pub fn fill(template: &str, values: &BTreeMap<&str, String>) -> String {
    let mut out = String::with_capacity(template.len() + 256);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if after[..close].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
                let key = &after[..close];
                match values.get(key) {
                    Some(v) => out.push_str(v),
                    None => {
                        out.push('{');
                        out.push_str(key);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_complete() {
        let roles = default_roles();
        assert_eq!(roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["orchestrator", "coder", "reviewer"]);
        for r in &roles {
            assert!(!r.system_prompt.is_empty());
            for t in &r.tools {
                assert!(crate::tools::tool_spec(t).is_some(), "{}: unknown tool {t}", r.id);
            }
        }
        let reviewer = roles.iter().find(|r| r.id == "reviewer").unwrap();
        assert!(!reviewer.tools.iter().any(|t| t == "edit_file" || t == "write_file"), "reviewer must not edit");
        let t = PromptTemplates::default();
        assert!(t.coder_task.contains("{task_title}"));
        assert!(t.notes.contains("{notes}") && t.notes.contains("{max_lines}"));
    }

    #[test]
    fn templates_saved_before_a_new_one_get_its_default() {
        let mut saved = serde_json::to_value(PromptTemplates::default()).unwrap();
        saved.as_object_mut().unwrap().remove("notes");
        saved["planner"] = "My planner {goal}".into();
        let t: PromptTemplates = serde_json::from_value(saved).unwrap();
        assert_eq!(t.planner, "My planner {goal}");
        assert_eq!(t.notes, PromptTemplates::default().notes);
    }

    #[test]
    fn fill_replaces_known_and_keeps_unknown() {
        let mut v = BTreeMap::new();
        v.insert("name", "Ylide".to_string());
        assert_eq!(fill("Hi {name}, {unknown} {", &v), "Hi Ylide, {unknown} {");
        assert_eq!(fill("json {\"a\": 1}", &v), "json {\"a\": 1}");
        v.insert("x", "{name}".to_string());
        assert_eq!(fill("{x}", &v), "{name}", "values are not re-expanded");
    }
}
