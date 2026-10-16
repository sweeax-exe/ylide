//! Orchestrates a run: plan -> for each task: Coder -> Reviewer (-> Coder ...) -> report.
//!
//! Execution strategy for a single local GPU: tasks run one after another, so
//! at most one agent generates at a time while the others wait. Each role gets
//! its own preferred llama-server slot, so when the Reviewer hands back to the
//! Coder, the Coder's long conversation prefix is still in the KV cache and
//! only the new feedback has to be processed. Questions between agents are
//! short side calls on the asked agent's slot. Roles can use a different
//! (smaller) model if configured; see `Team`.

use crate::checkpoints::Checkpoint;
use crate::edit::unified_diff;
use crate::knowledge;
use crate::llm::ChatModel;
use crate::previous::PreviousRun;
use crate::protocol::{AgentEvent, AgentState, MessageKind, Plan, Review, RunOutcome, Task, TaskStatus, Verdict};
use crate::roles::{RoleDefinition, fill};
use crate::runner::{AgentEnd, AgentSpec, AskRouter, PlanDraft, RunContext, run_agent};
use async_trait::async_trait;
use inference::{ChatMessage, ChatRequest};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// Roles plus the model each role runs on.
pub struct Team {
    pub roles: Vec<RoleDefinition>,
    pub models: HashMap<String, Arc<dyn ChatModel>>,
    /// Used for roles without an entry in `models`.
    pub default_model: Arc<dyn ChatModel>,
    pub max_review_rounds: u32,
    pub review_enabled: bool,
    /// After a run, the orchestrator updates Ylide's section of AGENTS.md.
    pub update_notes: bool,
}

impl Team {
    pub fn role(&self, id: &str) -> Option<&RoleDefinition> {
        self.roles.iter().find(|r| r.id == id)
    }

    fn model_for(&self, role: &str) -> Arc<dyn ChatModel> {
        self.models.get(role).cloned().unwrap_or_else(|| self.default_model.clone())
    }

    fn spec<'a>(&'a self, role: &'a RoleDefinition) -> AgentSpec<'a> {
        AgentSpec {
            id: role.id.clone(),
            role,
            model: self.model_for(&role.id),
        }
    }
}

struct Router<'a> {
    team: &'a Team,
}

#[async_trait]
impl AskRouter for Router<'_> {
    async fn ask(&self, ctx: &RunContext, from: &str, to: &str, question: &str, task_id: Option<&str>) -> Option<String> {
        if to == "user" {
            // Stopping the run must not wait for an answer that may never come.
            return tokio::select! {
                answer = ctx.broker.ask_user(from, question) => Some(answer),
                _ = ctx.control.cancel.cancelled() => None,
            };
        }
        let Some(role) = self.team.role(to) else {
            return Some(format!("There is no agent called '{to}'. Available: user, {}", self.team.roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", ")));
        };
        ctx.status(to, &role.id, AgentState::Thinking, &format!("answering {from}"), task_id);
        let overview = ctx.blackboard.lock().unwrap().overview();
        let mut values = BTreeMap::new();
        values.insert("overview", overview);
        values.insert("from", from.to_string());
        values.insert("question", question.to_string());
        let mut req = ChatRequest::new(vec![
            ChatMessage::system(role.system_prompt.clone()),
            ChatMessage::user(fill(&ctx.templates.question, &values)),
        ]);
        req.temperature = role.temperature;
        req.max_tokens = Some(800);
        let answer = match self.team.model_for(to).chat(req, &ctx.control.cancel, &mut |_| {}).await {
            Ok(r) => r.message.content.unwrap_or_default(),
            Err(_) if ctx.control.cancel.is_cancelled() => return None,
            Err(e) => format!("({to} could not answer: {e})"),
        };
        ctx.status(to, &role.id, AgentState::Idle, "", task_id);
        Some(if answer.trim().is_empty() { format!("({to} had no answer)") } else { answer })
    }
}

/// Final result of a run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunReport {
    pub outcome: RunOutcome,
    pub plan: Option<Plan>,
    pub summary: String,
    pub checkpoints: Vec<Checkpoint>,
}

/// One line about the OS and shell, so agents use the right command syntax.
/// It goes into the first user message (not the system prompt) to keep the
/// cached prompt prefix identical across machines and roles.
pub fn environment_description(shell: &crate::tools::ShellConfig) -> String {
    let os = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    };
    const PS_SYNTAX: &str = "use PowerShell syntax (Get-ChildItem, Select-String, Get-Content, Test-Path). Unix tools such as ls -la, grep, find, head or cat flags are not available.";
    let shell_name = shell.program_stem();
    let hint = if shell.is_windows_powershell() {
        format!(
            "Commands run in Windows PowerShell 5.1: {PS_SYNTAX} It has no && or ||: chain commands with ; or use separate calls."
        )
    } else if shell_name.contains("powershell") || shell_name.contains("pwsh") {
        format!("Commands run in PowerShell: {PS_SYNTAX}")
    } else if shell_name == "cmd" {
        "Commands run in cmd.exe: use Windows command syntax (dir, type, findstr).".into()
    } else {
        "Commands run in a POSIX shell (sh).".into()
    };
    format!(
        "{os}. {hint} Commands start in the project root: use project-relative paths instead of cd. Prefer the read_file, list_dir, search and find_files tools over shell commands for looking at files."
    )
}

fn roles_listing(team: &Team) -> String {
    team.roles
        .iter()
        .filter(|r| r.id != "orchestrator" && r.id != "reviewer")
        .map(|r| format!("- {}: {}", r.id, r.description))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Executes a full multi-agent run for `goal`.
pub async fn run(ctx: Arc<RunContext>, team: &Team, goal: &str) -> RunReport {
    run_with_previous(ctx, team, goal, None).await
}

/// Like [`run`]; with `previous`, the orchestrator plans with that run's
/// outcome in view, and the tasks it left open are done first.
pub async fn run_with_previous(ctx: Arc<RunContext>, team: &Team, goal: &str, previous: Option<&PreviousRun>) -> RunReport {
    ctx.emit(AgentEvent::RunStarted {
        run_id: ctx.run_id.clone(),
        goal: goal.to_string(),
    });
    let router = Router { team };

    // Long-term project knowledge: read once, shown to every role.
    let notes = ctx.ws.read_text(knowledge::FILE).map(|f| knowledge::prompt_section(&f.content, knowledge::PROMPT_CHARS)).unwrap_or_default();

    // ---- 1. Plan ------------------------------------------------------------
    let open = previous.map(PreviousRun::open_tasks).unwrap_or_default();
    if !open.is_empty() {
        // The run starts with them, so the planner may add nothing (see `submit_plan`).
        ctx.blackboard.lock().unwrap().plan = Some(Plan { goal: goal.to_string(), summary: String::new(), tasks: open.clone() });
    }
    let plan = match make_plan(&ctx, team, &router, goal, &notes, previous).await {
        Ok(p) => carry_over(p, open, previous.map_or(0, PreviousRun::last_task_number)),
        Err(outcome) => {
            // Open tasks stay in the report, so a later run still picks them up.
            let plan = ctx.blackboard.lock().unwrap().plan.clone();
            return finish(&ctx, outcome, plan, "The run was stopped before a plan was made.".into());
        }
    };
    ctx.blackboard.lock().unwrap().plan = Some(plan.clone());
    ctx.emit(AgentEvent::PlanReady {
        run_id: ctx.run_id.clone(),
        plan: plan.clone(),
    });

    // ---- 2. Tasks -----------------------------------------------------------
    let mut cancelled = false;
    for task in &plan.tasks {
        if ctx.control.cancel.is_cancelled() {
            cancelled = true;
            break;
        }
        if !run_task(&ctx, team, &router, &task.id, &notes).await {
            cancelled = ctx.control.cancel.is_cancelled();
            if cancelled {
                break;
            }
        }
    }

    // ---- 3. Project notes ---------------------------------------------------
    let learned = !ctx.commands_that_worked().is_empty()
        || ctx.blackboard.lock().unwrap().plan.as_ref().is_some_and(|p| p.tasks.iter().any(|t| t.status == TaskStatus::Done));
    if team.update_notes && !cancelled && learned {
        update_notes(&ctx, team).await;
    }

    // ---- 4. Report ----------------------------------------------------------
    let final_plan = ctx.blackboard.lock().unwrap().plan.clone();
    let summary = report(&ctx);
    let outcome = if cancelled {
        RunOutcome::Cancelled
    } else if final_plan.as_ref().is_some_and(|p| p.tasks.iter().all(|t| t.status == TaskStatus::Done)) {
        RunOutcome::Completed
    } else {
        RunOutcome::Failed
    };
    finish(&ctx, outcome, final_plan, summary)
}

fn finish(ctx: &RunContext, outcome: RunOutcome, plan: Option<Plan>, summary: String) -> RunReport {
    ctx.emit(AgentEvent::RunFinished {
        run_id: ctx.run_id.clone(),
        outcome,
        summary: summary.clone(),
    });
    RunReport {
        outcome,
        plan,
        summary,
        checkpoints: ctx.checkpoints.list(&ctx.run_id),
    }
}

async fn make_plan(
    ctx: &RunContext,
    team: &Team,
    router: &Router<'_>,
    goal: &str,
    notes: &str,
    previous: Option<&PreviousRun>,
) -> Result<Plan, RunOutcome> {
    let Some(role) = team.role("orchestrator") else {
        return Ok(single_task_plan(goal));
    };
    let mut values = BTreeMap::new();
    values.insert("goal", goal.to_string());
    values.insert("roles", roles_listing(team));
    values.insert("outline", ctx.ws.outline("", 2, 150).unwrap_or_default());
    values.insert("environment", environment_description(&ctx.shell));
    let mut conversation = vec![
        ChatMessage::system(role.system_prompt.clone()),
        ChatMessage::user(planning_request(&ctx.templates.planner, values, notes, previous)),
    ];
    let end = run_agent(ctx, &team.spec(role), &mut conversation, None, None, router).await;
    ctx.status("orchestrator", "orchestrator", AgentState::Idle, "plan ready", None);
    let draft = match end {
        AgentEnd::Plan(p) => p,
        AgentEnd::Cancelled => return Err(RunOutcome::Cancelled),
        // Models that answer in text: accept a JSON plan in the text, else one task.
        AgentEnd::Text(t) => parse_plan_text(&t).unwrap_or_else(|| draft_single(goal)),
        _ => draft_single(goal),
    };
    Ok(to_plan(goal, draft, team))
}

/// Fills the planner template with the project notes and the previous run's section.
fn planning_request(template: &str, values: BTreeMap<&str, String>, notes: &str, previous: Option<&PreviousRun>) -> String {
    let section = previous.map(|p| format!("{}\n", p.describe())).unwrap_or_default();
    fill_sections(template, values, &[("project_notes", notes.to_string()), ("previous", section)])
}

/// Fills `template`. Each of `sections` goes where the template names it, or
/// in front, in order, for templates saved before that field existed.
fn fill_sections(template: &str, mut values: BTreeMap<&str, String>, sections: &[(&'static str, String)]) -> String {
    let mut front = String::new();
    for (key, text) in sections {
        if !template.contains(&format!("{{{key}}}")) {
            front.push_str(text);
        }
        values.insert(key, text.clone());
    }
    front + &fill(template, &values)
}

/// Rewrites Ylide's section of AGENTS.md with what the run showed, through
/// the normal write path: it asks first in "ask" mode, gets a checkpoint, and
/// shows up in the run's changed files.
async fn update_notes(ctx: &RunContext, team: &Team) {
    let Some(role) = team.role("orchestrator") else { return };
    let existing = ctx.ws.read_text(knowledge::FILE).ok().map(|f| f.content);
    let current = existing.as_deref().and_then(knowledge::notes).filter(|n| !n.is_empty());
    ctx.status("orchestrator", &role.id, AgentState::Thinking, NOTES_STEP, None);
    let commands = ctx.commands_that_worked();
    let mut values = BTreeMap::new();
    values.insert("notes", current.clone().unwrap_or_else(|| "(none yet)".into()));
    values.insert("overview", ctx.blackboard.lock().unwrap().overview());
    values.insert(
        "commands",
        if commands.is_empty() { "(none)".into() } else { commands.iter().map(|c| format!("- {c}")).collect::<Vec<_>>().join("\n") },
    );
    values.insert("max_lines", knowledge::MAX_LINES.to_string());
    let mut req = ChatRequest::new(vec![
        ChatMessage::system(role.system_prompt.clone()),
        ChatMessage::user(fill(&ctx.templates.notes, &values)),
    ]);
    req.temperature = role.temperature;
    req.max_tokens = Some(1_500);
    let answer = team.model_for(&role.id).chat(req, &ctx.control.cancel, &mut |_| {}).await;
    let notes = answer.map(|r| knowledge::clean_notes(&r.message.content.unwrap_or_default())).unwrap_or_default();
    if !notes.is_empty() && current.as_deref() != Some(notes.as_str()) && !ctx.control.cancel.is_cancelled() {
        // The file was read just now, so writing it is no blind overwrite.
        ctx.mark_read(knowledge::FILE);
        let content = knowledge::merge(existing.as_deref(), &notes);
        let args = serde_json::json!({ "path": knowledge::FILE, "content": content });
        crate::runner::call_tool(ctx, &team.spec(role), "write_file", args).await;
    }
    ctx.status("orchestrator", &role.id, AgentState::Idle, "", None);
}

/// Step text while the orchestrator writes the project notes (the UI translates it).
pub const NOTES_STEP: &str = "updating project notes";

/// The previous run's open tasks first, with their ids; the new tasks after
/// them, numbered on from the previous run's last task.
fn carry_over(mut plan: Plan, open: Vec<Task>, last_number: usize) -> Plan {
    if open.is_empty() {
        return plan;
    }
    let new = std::mem::replace(&mut plan.tasks, open);
    for (i, mut task) in new.into_iter().enumerate() {
        task.id = format!("T{}", last_number + i + 1);
        plan.tasks.push(task);
    }
    plan
}

fn draft_single(goal: &str) -> PlanDraft {
    PlanDraft {
        summary: "Implement the request directly.".into(),
        tasks: vec![crate::runner::TaskDraft {
            title: crate::protocol::first_line(goal, 80),
            description: goal.to_string(),
            files: vec![],
            assignee: None,
        }],
    }
}

fn single_task_plan(goal: &str) -> Plan {
    let draft = draft_single(goal);
    Plan {
        goal: goal.to_string(),
        summary: draft.summary,
        tasks: draft
            .tasks
            .into_iter()
            .map(|t| new_task(1, t.title, t.description, t.files, "coder".into()))
            .collect(),
    }
}

fn parse_plan_text(text: &str) -> Option<PlanDraft> {
    crate::runner::parse_json_object::<PlanDraft>(text).filter(|p| !p.tasks.is_empty())
}

fn new_task(n: usize, title: String, description: String, files: Vec<String>, assignee: String) -> Task {
    Task {
        id: format!("T{n}"),
        title,
        description,
        files,
        assignee,
        status: TaskStatus::Pending,
        attempts: 0,
        result: None,
        review: None,
    }
}

fn to_plan(goal: &str, draft: PlanDraft, team: &Team) -> Plan {
    Plan {
        goal: goal.to_string(),
        summary: draft.summary,
        tasks: draft
            .tasks
            .into_iter()
            .take(12)
            .enumerate()
            .map(|(i, t)| {
                // Unknown or non-executing roles fall back to the coder.
                let assignee = t
                    .assignee
                    .filter(|a| team.role(a).is_some() && a != "orchestrator" && a != "reviewer")
                    .unwrap_or_else(|| "coder".into());
                new_task(i + 1, t.title, t.description, t.files, assignee)
            })
            .collect(),
    }
}

fn update_task(ctx: &RunContext, task_id: &str, f: impl FnOnce(&mut Task)) -> Option<Task> {
    let mut bb = ctx.blackboard.lock().unwrap();
    let task = bb.task_mut(task_id)?;
    f(task);
    let snapshot = task.clone();
    drop(bb);
    ctx.emit(AgentEvent::TaskUpdated {
        run_id: ctx.run_id.clone(),
        task: snapshot.clone(),
    });
    Some(snapshot)
}

/// Diff of everything changed under `checkpoint` (original vs. current).
fn checkpoint_diff(ctx: &RunContext, checkpoint_id: &str) -> String {
    let Some(cp) = ctx.checkpoints.list(&ctx.run_id).into_iter().find(|c| c.id == checkpoint_id) else {
        return String::new();
    };
    let mut out = String::new();
    for f in &cp.files {
        let before = ctx
            .checkpoints
            .original(f)
            .ok()
            .flatten()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let after = ctx.ws.read_text(&f.path).map(|t| t.content).unwrap_or_default();
        if before != after {
            out.push_str(&unified_diff(&f.path, &before, &after));
        }
    }
    out
}

fn format_review(review: &Review) -> String {
    let mut s = review.summary.clone();
    for c in &review.comments {
        let loc = match (&c.file, c.line) {
            (Some(f), Some(l)) => format!("{f}:{l}"),
            (Some(f), None) => f.clone(),
            _ => "general".into(),
        };
        let severity = match c.severity {
            crate::protocol::Severity::Blocker => "blocker",
            crate::protocol::Severity::Major => "major",
            crate::protocol::Severity::Minor => "minor",
            crate::protocol::Severity::Nit => "nit",
        };
        s.push_str(&format!("\n- [{severity}] {loc}: {}", c.message));
    }
    s
}

/// Runs one task through Coder and Reviewer. Returns false if it failed.
async fn run_task(ctx: &RunContext, team: &Team, router: &Router<'_>, task_id: &str, notes: &str) -> bool {
    let Some(task) = update_task(ctx, task_id, |t| t.status = TaskStatus::InProgress) else { return false };
    let checkpoint = match ctx.checkpoints.begin(&ctx.run_id, &format!("{}: {} ({})", task.id, task.title, task.assignee)) {
        Ok(c) => c,
        Err(e) => {
            update_task(ctx, task_id, |t| {
                t.status = TaskStatus::Failed;
                t.result = Some(format!("could not create checkpoint: {e}"));
            });
            return false;
        }
    };
    ctx.emit(AgentEvent::CheckpointCreated {
        run_id: ctx.run_id.clone(),
        checkpoint: checkpoint.clone(),
    });

    let Some(worker_role) = team.role(&task.assignee).or_else(|| team.role("coder")) else { return false };
    let worker = team.spec(worker_role);
    let mut values = BTreeMap::new();
    values.insert("overview", ctx.blackboard.lock().unwrap().overview());
    values.insert("task_id", task.id.clone());
    values.insert("task_title", task.title.clone());
    values.insert("task_description", task.description.clone());
    values.insert("task_files", if task.files.is_empty() { "(none)".into() } else { task.files.join(", ") });
    values.insert("environment", environment_description(&ctx.shell));
    let mut conversation = vec![
        ChatMessage::system(worker_role.system_prompt.clone()),
        ChatMessage::user(fill_sections(&ctx.templates.coder_task, values, &[("project_notes", notes.to_string())])),
    ];

    loop {
        let end = run_agent(ctx, &worker, &mut conversation, Some(task_id), Some(&checkpoint.id), router).await;
        let summary = match end {
            AgentEnd::Finished(s) | AgentEnd::Text(s) => s,
            AgentEnd::Cancelled => {
                update_task(ctx, task_id, |t| t.status = TaskStatus::Skipped);
                return false;
            }
            AgentEnd::StepLimit => {
                update_task(ctx, task_id, |t| {
                    t.status = TaskStatus::Failed;
                    t.result = Some("Stopped: step limit reached before the task was finished.".into());
                });
                return false;
            }
            AgentEnd::Failed(e) => {
                update_task(ctx, task_id, |t| {
                    t.status = TaskStatus::Failed;
                    t.result = Some(format!("Stopped: {e}"));
                });
                return false;
            }
            AgentEnd::Plan(_) | AgentEnd::Review(_) => "Done.".to_string(),
        };
        let task = update_task(ctx, task_id, |t| {
            t.result = Some(summary.clone());
            t.status = TaskStatus::InReview;
        })
        .expect("task exists");

        let diff = checkpoint_diff(ctx, &checkpoint.id);
        let review = match (team.review_enabled, team.role("reviewer")) {
            (true, Some(reviewer_role)) if !diff.is_empty() => {
                let mut values = BTreeMap::new();
                values.insert("task_id", task.id.clone());
                values.insert("task_title", task.title.clone());
                values.insert("task_description", task.description.clone());
                values.insert("summary", summary.clone());
                values.insert("diff", crate::tools::truncate_middle(&diff, 40_000));
                values.insert("environment", environment_description(&ctx.shell));
                let mut review_conv = vec![
                    ChatMessage::system(reviewer_role.system_prompt.clone()),
                    ChatMessage::user(fill_sections(&ctx.templates.reviewer_task, values, &[("project_notes", notes.to_string())])),
                ];
                match run_agent(ctx, &team.spec(reviewer_role), &mut review_conv, Some(task_id), Some(&checkpoint.id), router).await {
                    AgentEnd::Review(r) => Some(r),
                    AgentEnd::Cancelled => {
                        update_task(ctx, task_id, |t| t.status = TaskStatus::Skipped);
                        return false;
                    }
                    other => Some(Review {
                        verdict: Verdict::Approve,
                        summary: format!("Reviewer did not submit a verdict ({}); accepted without review.", end_label(&other)),
                        comments: vec![],
                    }),
                }
            }
            _ => None,
        };
        ctx.status("reviewer", "reviewer", AgentState::Idle, "", Some(task_id));

        match review {
            Some(r) if r.verdict == Verdict::RequestChanges && task.attempts < team.max_review_rounds => {
                let round = task.attempts + 1;
                update_task(ctx, task_id, |t| {
                    t.attempts = round;
                    t.review = Some(r.clone());
                    t.status = TaskStatus::InProgress;
                });
                let feedback = format_review(&r);
                ctx.post_message("reviewer", &worker.id, MessageKind::Feedback, &feedback, Some(task_id));
                let mut values = BTreeMap::new();
                values.insert("round", round.to_string());
                values.insert("max_rounds", team.max_review_rounds.to_string());
                values.insert("review", feedback);
                conversation.push(ChatMessage::user(fill(&ctx.templates.feedback, &values)));
            }
            other => {
                update_task(ctx, task_id, |t| {
                    t.review = other;
                    t.status = TaskStatus::Done;
                });
                return true;
            }
        }
    }
}

fn end_label(end: &AgentEnd) -> &'static str {
    match end {
        AgentEnd::StepLimit => "step limit",
        AgentEnd::Failed(_) => "error",
        AgentEnd::Text(_) => "plain-text answer",
        _ => "no review",
    }
}

fn report(ctx: &RunContext) -> String {
    let bb = ctx.blackboard.lock().unwrap();
    let Some(plan) = &bb.plan else { return "No plan was made.".into() };
    let mut s = String::new();
    for t in &plan.tasks {
        let icon = match t.status {
            TaskStatus::Done => "✔",
            TaskStatus::Failed => "✘",
            TaskStatus::Skipped => "–",
            _ => "…",
        };
        s.push_str(&format!("{icon} {} {}\n", t.id, t.title));
        if let Some(r) = &t.result {
            s.push_str(&format!("   {}\n", crate::protocol::first_line(r, 200)));
        }
        if let Some(review) = &t.review
            && review.verdict == Verdict::RequestChanges
        {
            s.push_str("   Reviewer still had open comments after the last round.\n");
        }
    }
    if !bb.changed_files.is_empty() {
        s.push_str(&format!("\nChanged files: {}\n", bb.changed_files.iter().cloned().collect::<Vec<_>>().join(", ")));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ShellConfig;

    #[test]
    fn the_previous_run_goes_into_the_planning_request() {
        let values = || BTreeMap::from([("goal", "Now add tests".to_string())]);
        let previous = PreviousRun::new("Add a cart", RunOutcome::Completed, "", &crate::protocol::Blackboard::default(), vec![]);
        let template = "{previous}Request from the user:\n{goal}";

        let fresh = planning_request(template, values(), "", None);
        assert_eq!(fresh, "Request from the user:\nNow add tests", "a fresh run is unchanged");

        let continued = planning_request(template, values(), "", Some(&previous));
        assert!(continued.starts_with("Previous run (the request below continues it"), "{continued}");
        assert!(continued.contains("Request: Add a cart\n"), "{continued}");
        assert!(continued.ends_with("\n\nRequest from the user:\nNow add tests"), "{continued}");

        // Templates saved before `{previous}` existed still get the section, in front.
        let old = planning_request("Request from the user:\n{goal}", values(), "", Some(&previous));
        assert_eq!(old, continued);
        assert_eq!(planning_request("Request from the user:\n{goal}", values(), "", None), fresh);
    }

    #[test]
    fn project_notes_go_first_also_in_templates_without_the_field() {
        let values = || BTreeMap::from([("goal", "Fix it".to_string())]);
        let previous = PreviousRun::new("Add a cart", RunOutcome::Completed, "", &crate::protocol::Blackboard::default(), vec![]);
        let notes = "Project notes from AGENTS.md ...\n\n";
        let current = planning_request("{project_notes}{previous}Request: {goal}", values(), notes, Some(&previous));
        assert!(current.starts_with(notes), "{current}");
        assert!(current.contains("\n\nRequest: Fix it"));
        let old = planning_request("Request: {goal}", values(), notes, Some(&previous));
        assert_eq!(old, current, "saved templates get both sections in front, in the same order");
        assert_eq!(planning_request("Request: {goal}", values(), "", None), "Request: Fix it");
        let coder = fill_sections("Task: {task}", BTreeMap::from([("task", "T1".to_string())]), &[("project_notes", notes.to_string())]);
        assert_eq!(coder, format!("{notes}Task: T1"));
    }

    #[test]
    fn open_tasks_come_first_and_new_tasks_are_numbered_on() {
        let task = |id: &str| new_task(0, id.into(), String::new(), vec![], "coder".into());
        let renumber = |mut t: Task, id: &str| {
            t.id = id.into();
            t
        };
        let plan = |tasks| Plan { goal: "go on".into(), summary: String::new(), tasks };
        let new = vec![renumber(task("New 1"), "T1"), renumber(task("New 2"), "T2")];
        let open = vec![renumber(task("Old 3"), "T3"), renumber(task("Old 5"), "T5")];

        let merged = carry_over(plan(new.clone()), open.clone(), 6);
        let ids: Vec<(&str, &str)> = merged.tasks.iter().map(|t| (t.id.as_str(), t.title.as_str())).collect();
        assert_eq!(ids, vec![("T3", "Old 3"), ("T5", "Old 5"), ("T7", "New 1"), ("T8", "New 2")]);

        assert_eq!(carry_over(plan(vec![]), open.clone(), 6).tasks, open, "nothing new: only the open tasks");
        assert_eq!(carry_over(plan(new.clone()), vec![], 6).tasks, new, "nothing open: the plan as it is");
    }

    #[test]
    fn the_default_planner_template_has_a_place_for_the_previous_run() {
        let t = crate::roles::PromptTemplates::default();
        assert!(t.planner.starts_with("{project_notes}{previous}"), "{}", t.planner);
        for (name, template) in [("coderTask", &t.coder_task), ("reviewerTask", &t.reviewer_task)] {
            assert!(template.starts_with("{project_notes}"), "{name}: {template}");
        }
    }

    #[test]
    fn environment_matches_the_shell() {
        let describe =
            |program: &str| environment_description(&ShellConfig { program: program.into(), ..ShellConfig::default() });
        let ps = describe("powershell.exe");
        assert!(ps.contains("Windows PowerShell 5.1") && ps.contains("no && or ||"), "{ps}");
        let pwsh = describe(r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert!(pwsh.contains("PowerShell syntax") && !pwsh.contains("&&"), "{pwsh}");
        let cmd = describe("cmd.exe");
        assert!(cmd.contains("cmd.exe") && !cmd.contains("&&"), "{cmd}");
        let sh = describe("sh");
        assert!(sh.contains("POSIX") && !sh.contains("&&"), "{sh}");
        for d in [ps, pwsh, cmd, sh] {
            assert!(d.contains("project-relative paths instead of cd"), "{d}");
        }
    }
}
