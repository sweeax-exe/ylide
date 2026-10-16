//! Agent mode: an orchestrator plans, a Coder implements, a Reviewer checks.
//!
//! * [`tools`]: what agents can do in the project, with JSON schemas.
//! * [`permissions`]: when the user is asked (`ask` / `autoSafe` / `autonomous`).
//! * [`checkpoints`]: every change can be undone per task.
//! * [`runner`]: the loop for one agent; [`orchestrator`]: the multi-agent run.
//! * [`roles`]: editable role definitions and prompt templates (no hidden prompts).

pub mod checkpoints;
pub mod edit;
pub mod llm;
pub mod orchestrator;
pub mod permissions;
pub mod protocol;
pub mod roles;
pub mod runner;
pub mod textcalls;
pub mod tools;

pub use checkpoints::{Checkpoint, CheckpointStore};
pub use llm::{ChatModel, ScheduledModel, ScriptedModel};
pub use orchestrator::{RunReport, Team, run};
pub use permissions::{ApprovalBroker, ApprovalMode, ApprovalRequest, ApprovalResponse, PermissionSettings};
pub use protocol::*;
pub use roles::{PromptTemplates, RoleDefinition, default_roles};
pub use runner::{AgentEnd, RunContext, RunControl};
pub use tools::ShellConfig;

#[cfg(test)]
mod run_tests;
