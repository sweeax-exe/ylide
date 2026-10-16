//! Agent mode: an orchestrator plans, a Coder implements, a Reviewer checks.
//!
//! * [`tools`]: what agents can do in the project, with JSON schemas.
//! * [`permissions`]: when the user is asked (`ask` / `autoSafe` / `autonomous`).
//! * [`checkpoints`]: every change can be undone per task.
//! * [`runner`]: the loop for one agent; [`orchestrator`]: the multi-agent run.
//! * [`previous`]: what a run that continues an earlier one is told about it.
//! * [`knowledge`]: long-term project notes in the project's `AGENTS.md`.
//! * [`roles`]: editable role definitions and prompt templates (no hidden prompts).

pub mod checkpoints;
pub mod edit;
pub mod knowledge;
pub mod llm;
pub mod orchestrator;
pub mod permissions;
pub mod previous;
pub mod protocol;
pub mod roles;
pub mod runner;
pub mod textcalls;
pub mod tools;

pub use checkpoints::{Checkpoint, CheckpointStore};
pub use llm::{ChatModel, ScheduledModel, ScriptedModel};
pub use orchestrator::{RunReport, Team, run, run_with_previous};
pub use permissions::{ApprovalBroker, ApprovalMode, ApprovalRequest, ApprovalResponse, PermissionSettings};
pub use previous::PreviousRun;
pub use protocol::*;
pub use roles::{PromptTemplates, RoleDefinition, default_roles};
pub use runner::{AgentEnd, RunContext, RunControl};
pub use tools::ShellConfig;

#[cfg(test)]
mod run_tests;
