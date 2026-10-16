//! The shared vocabulary of a multi-agent run: plan, tasks, reviews, messages
//! between agents, and the events streamed to the UI.
//!
//! Sub-agents never talk to each other directly. Everything goes through the
//! run's [`Blackboard`], which the orchestrator owns. Every agent sees the plan,
//! the task list with results, and the messages addressed to it.

use crate::checkpoints::Checkpoint;
use inference::Delta;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TaskStatus {
    Pending,
    InProgress,
    InReview,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Task {
    /// "T1", "T2", ...
    pub id: String,
    pub title: String,
    pub description: String,
    /// Files the planner expects to be touched (hint only).
    #[serde(default)]
    pub files: Vec<String>,
    /// Role that executes the task (default "coder").
    #[serde(default = "default_assignee")]
    pub assignee: String,
    pub status: TaskStatus,
    /// Review rounds used so far.
    pub attempts: u32,
    /// Coder's final summary.
    pub result: Option<String>,
    pub review: Option<Review>,
}

fn default_assignee() -> String {
    "coder".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "TaskPlan")]
pub struct Plan {
    pub goal: String,
    /// One paragraph describing the approach.
    pub summary: String,
    pub tasks: Vec<Task>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Verdict {
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Severity {
    Blocker,
    Major,
    Minor,
    Nit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewComment {
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    pub severity: Severity,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Review {
    pub verdict: Verdict,
    pub summary: String,
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MessageKind {
    /// An agent asks another agent (or the user) something.
    Question,
    Answer,
    /// Reviewer -> Coder change requests.
    Feedback,
    /// The user stepped in.
    Intervention,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: MessageKind,
    pub content: String,
    pub task_id: Option<String>,
}

/// Shared state of one run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Blackboard {
    pub plan: Option<Plan>,
    pub messages: Vec<AgentMessage>,
    pub changed_files: BTreeSet<String>,
}

impl Blackboard {
    /// Compact plan + progress overview injected into every agent's prompt.
    pub fn overview(&self) -> String {
        let Some(plan) = &self.plan else { return "No plan yet.".into() };
        let mut s = format!("Goal: {}\nApproach: {}\nTasks:\n", plan.goal, plan.summary);
        for t in &plan.tasks {
            s.push_str(&format!("- [{}] {} ({:?})", t.id, t.title, t.status));
            if let Some(r) = &t.result {
                s.push_str(&format!(" -> {}", first_line(r, 160)));
            }
            s.push('\n');
        }
        if !self.changed_files.is_empty() {
            s.push_str(&format!(
                "Files changed so far: {}\n",
                self.changed_files.iter().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        s
    }

    pub fn task_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.plan.as_mut()?.tasks.iter_mut().find(|t| t.id == id)
    }
}

pub(crate) fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or_default();
    if line.chars().count() > max { format!("{}…", line.chars().take(max).collect::<String>()) } else { line.to_string() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AgentState {
    Idle,
    Queued,
    Thinking,
    CallingTool,
    WaitingForApproval,
    WaitingForAnswer,
    Paused,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentStatus {
    pub agent_id: String,
    pub role: String,
    pub state: AgentState,
    /// Human readable current step, e.g. "edit_file src/main.rs".
    pub step: String,
    pub task_id: Option<String>,
    pub tokens_per_second: f64,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
    /// Unified diff (for display).
    pub diff: String,
    pub checkpoint_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RunOutcome {
    Completed,
    Cancelled,
    Failed,
}

/// Everything the UI needs to render the agent overview, streamed live.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "type")]
#[ts(export)]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    RunStarted { run_id: String, goal: String },
    #[serde(rename_all = "camelCase")]
    Status { run_id: String, status: AgentStatus },
    #[serde(rename_all = "camelCase")]
    Delta { run_id: String, agent_id: String, delta: Delta },
    #[serde(rename_all = "camelCase")]
    PlanReady { run_id: String, plan: Plan },
    #[serde(rename_all = "camelCase")]
    TaskUpdated { run_id: String, task: Task },
    #[serde(rename_all = "camelCase")]
    ToolCall { run_id: String, agent_id: String, call_id: String, tool: String, arguments: String },
    #[serde(rename_all = "camelCase")]
    ToolResult { run_id: String, agent_id: String, call_id: String, ok: bool, summary: String, change: Option<FileChange> },
    #[serde(rename_all = "camelCase")]
    ApprovalRequested { run_id: String, request: crate::permissions::ApprovalRequest },
    /// An agent asks the user something and waits for the answer.
    #[serde(rename_all = "camelCase")]
    QuestionForUser { run_id: String, question_id: String, agent_id: String, question: String },
    #[serde(rename_all = "camelCase")]
    Message { run_id: String, message: AgentMessage },
    #[serde(rename_all = "camelCase")]
    CheckpointCreated { run_id: String, checkpoint: Checkpoint },
    #[serde(rename_all = "camelCase")]
    RunFinished { run_id: String, outcome: RunOutcome, summary: String },
}
