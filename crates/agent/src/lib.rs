//! Agent mode: an orchestrator plans, a Coder implements, a Reviewer checks.
//!
//! * [`tools`]: what agents can do in the project, with JSON schemas.
//! * [`permissions`]: when the user is asked (`ask` / `autoSafe` / `autonomous`).
//! * [`checkpoints`]: every change can be undone per task.
//! * [`runner`]: the loop for one agent; [`orchestrator`]: the multi-agent run.
//! * [`planning`]: planning mode, where agents only read and write a plan
//!   the user reviews and edits before it is carried out.
//! * [`previous`]: what a run that continues an earlier one is told about it.
//! * [`knowledge`]: long-term project notes in the project's `AGENTS.md`.
//! * [`questions`]: questions for the user with answers to click, and the
//!   orchestrator's one round of them before it plans.
//! * [`recap`]: the summary a run ends with, in the user's language.
//! * [`roles`]: editable role definitions and prompt templates (no hidden prompts).

pub mod checkpoints;
pub mod edit;
pub mod knowledge;
pub mod llm;
pub mod orchestrator;
pub mod permissions;
pub mod planning;
pub mod previous;
pub mod protocol;
pub mod questions;
pub mod recap;
pub mod roles;
pub mod runner;
pub mod textcalls;
pub mod tools;

pub use checkpoints::{Checkpoint, CheckpointStore};
pub use llm::{ChatModel, ScheduledModel, ScriptedModel};
pub use orchestrator::{RunReport, Team, draft_plan, run, run_plan, run_with_previous};
pub use permissions::{ApprovalBroker, ApprovalMode, ApprovalRequest, ApprovalResponse, PermissionSettings, UserReply};
pub use planning::{PlanDoc, PlanRequest, PlanStep};
pub use previous::PreviousRun;
pub use protocol::*;
pub use questions::{Question, QuestionLevel};
pub use roles::{PromptTemplates, RoleDefinition, default_roles};
pub use runner::{AgentEnd, RunContext, RunControl};
pub use tools::ShellConfig;

#[cfg(test)]
mod run_tests;
