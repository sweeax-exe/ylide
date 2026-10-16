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
use crate::llm::ChatModel;
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
    ctx.emit(AgentEvent::RunStarted {
        run_id: ctx.run_id.clone(),
        goal: goal.to_string(),
    });
    let router = Router { team };

    // ---- 1. Plan ------------------------------------------------------------
    let plan = match make_plan(&ctx, team, &router, goal).await {
        Ok(p) => p,
        Err(outcome) => return finish(&ctx, outcome, None, "The run was stopped before a plan was made.".into()),
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
        if !run_task(&ctx, team, &router, &task.id).await {
            cancelled = ctx.control.cancel.is_cancelled();
            if cancelled {
                break;
            }
        }
    }

    // ---- 3. Report ----------------------------------------------------------
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

async fn make_plan(ctx: &RunContext, team: &Team, router: &Router<'_>, goal: &str) -> Result<Plan, RunOutcome> {
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
        ChatMessage::user(fill(&ctx.templates.planner, &values)),
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
async fn run_task(ctx: &RunContext, team: &Team, router: &Router<'_>, task_id: &str) -> bool {
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
        ChatMessage::user(fill(&ctx.templates.coder_task, &values)),
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
                    ChatMessage::user(fill(&ctx.templates.reviewer_task, &values)),
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
