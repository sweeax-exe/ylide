//! A run that continues an earlier one: what the orchestrator is told about it.
//!
//! Local models have small contexts, so this is a short digest with a bound on
//! every part: the request, how it ended, the tasks with their status and
//! result, and the changed files. The run's final summary is built from the
//! same task results, so it only appears when there were no tasks.
//!
//! Tasks the previous run did not finish are not planned again: they carry
//! over into the new run as they were ([`PreviousRun::open_tasks`]), and the
//! orchestrator only plans what the new request adds.

use crate::protocol::{Blackboard, RunOutcome, Task, TaskStatus};

/// Starts the note a carried-over task gets about its last attempt.
const ATTEMPT_NOTE: &str = "Earlier attempt: ";

/// Characters kept of the previous request.
const GOAL_CHARS: usize = 400;
/// Requests of runs before the previous one, and characters kept of each.
pub const MAX_EARLIER_GOALS: usize = 3;
const EARLIER_GOAL_CHARS: usize = 160;
const APPROACH_CHARS: usize = 300;
const TITLE_CHARS: usize = 100;
const RESULT_CHARS: usize = 160;
const SUMMARY_CHARS: usize = 600;
const MAX_FILES: usize = 20;

/// The finished run a new run continues.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviousRun {
    pub goal: String,
    pub outcome: RunOutcome,
    /// The plan's approach (empty when no plan was made).
    pub approach: String,
    pub tasks: Vec<Task>,
    /// The final report; shown only when there were no tasks.
    pub summary: String,
    pub changed_files: Vec<String>,
    /// Requests of the runs it continued in turn, oldest first.
    pub earlier_goals: Vec<String>,
}

impl PreviousRun {
    /// Takes plan and changed files from the finished run's blackboard.
    pub fn new(
        goal: &str,
        outcome: RunOutcome,
        summary: &str,
        blackboard: &Blackboard,
        earlier_goals: Vec<String>,
    ) -> Self {
        let plan = blackboard.plan.as_ref();
        Self {
            goal: goal.to_string(),
            outcome,
            approach: plan.map(|p| p.summary.clone()).unwrap_or_default(),
            tasks: plan.map(|p| p.tasks.clone()).unwrap_or_default(),
            summary: summary.to_string(),
            changed_files: blackboard.changed_files.iter().cloned().collect(),
            earlier_goals,
        }
    }

    /// Requests a run that continues this one passes on: the earlier ones plus this one.
    pub fn goal_chain(&self) -> Vec<String> {
        let mut goals = self.earlier_goals.clone();
        goals.push(self.goal.clone());
        let skip = goals.len().saturating_sub(MAX_EARLIER_GOALS);
        goals.split_off(skip)
    }

    /// The tasks it did not finish, to be done first in the run that
    /// continues it: open again, same id, with a note on the last attempt.
    pub fn open_tasks(&self) -> Vec<Task> {
        self.tasks
            .iter()
            .filter(|t| t.status != TaskStatus::Done)
            .map(|t| {
                // A task carried over again gets a new note instead of a second one.
                let base = t.description.find(ATTEMPT_NOTE).map_or(t.description.as_str(), |i| &t.description[..i]).trim_end();
                let result = t.result.as_deref().map(|r| one_line(r, RESULT_CHARS)).filter(|r| !r.is_empty());
                let note = match (t.status, result) {
                    (TaskStatus::Failed, Some(r)) => Some(format!("failed ({r})")),
                    (TaskStatus::Failed, None) => Some("failed".to_string()),
                    (TaskStatus::InReview, Some(r)) => {
                        Some(format!("stopped during the review; the changes are in the project ({r})"))
                    }
                    (TaskStatus::InProgress | TaskStatus::InReview | TaskStatus::Skipped, _) => {
                        Some("stopped before it was done; changes made so far are in the project".to_string())
                    }
                    _ => None,
                };
                Task {
                    description: match note {
                        Some(n) if base.is_empty() => format!("{ATTEMPT_NOTE}{n}."),
                        Some(n) => format!("{base}\n\n{ATTEMPT_NOTE}{n}."),
                        None => base.to_string(),
                    },
                    status: TaskStatus::Pending,
                    attempts: 0,
                    result: None,
                    review: None,
                    ..t.clone()
                }
            })
            .collect()
    }

    /// Highest task number ("T7" is 7), so tasks of the new run get fresh ids.
    pub fn last_task_number(&self) -> usize {
        self.tasks.iter().filter_map(|t| t.id.strip_prefix('T')?.parse().ok()).max().unwrap_or(0)
    }

    /// The "Previous run" section of the planning request.
    pub fn describe(&self) -> String {
        let mut s =
            String::from("Previous run (the request below continues it; its changes are already in the project):\n");
        let earlier = &self.earlier_goals[self.earlier_goals.len().saturating_sub(MAX_EARLIER_GOALS)..];
        if !earlier.is_empty() {
            s.push_str("Earlier requests:\n");
            for goal in earlier {
                s.push_str(&format!("- {}\n", one_line(goal, EARLIER_GOAL_CHARS)));
            }
        }
        s.push_str(&format!("Request: {}\n", one_line(&self.goal, GOAL_CHARS)));
        s.push_str(&format!("Outcome: {}\n", outcome_text(self.outcome)));
        if !self.approach.trim().is_empty() {
            s.push_str(&format!("Approach: {}\n", one_line(&self.approach, APPROACH_CHARS)));
        }
        if self.tasks.is_empty() {
            if !self.summary.trim().is_empty() {
                s.push_str(&format!("Result: {}\n", one_line(&self.summary, SUMMARY_CHARS)));
            }
            if self.outcome != RunOutcome::Completed {
                s.push_str("It made no plan. If the new request only asks to go on, plan the previous request.\n");
            }
        } else {
            s.push_str("Tasks:\n");
            for t in &self.tasks {
                s.push_str(&format!("- [{}] {} ({})", t.id, one_line(&t.title, TITLE_CHARS), status_text(t.status)));
                if let Some(r) = t.result.as_deref().filter(|r| !r.trim().is_empty()) {
                    s.push_str(&format!(" -> {}", one_line(r, RESULT_CHARS)));
                }
                s.push('\n');
            }
            let open: Vec<&str> =
                self.tasks.iter().filter(|t| t.status != TaskStatus::Done).map(|t| t.id.as_str()).collect();
            if !open.is_empty() {
                s.push_str(&format!(
                    "The open tasks ({}) carry over into this run as they are and are done first. Plan only what the new request adds; if it only asks to go on, submit an empty task list.\n",
                    open.join(", ")
                ));
            }
        }
        if self.changed_files.is_empty() {
            s.push_str("Changed files: none\n");
        } else {
            let shown = self.changed_files.iter().take(MAX_FILES).cloned().collect::<Vec<_>>().join(", ");
            let more = self.changed_files.len().saturating_sub(MAX_FILES);
            if more > 0 {
                s.push_str(&format!("Changed files: {shown} and {more} more\n"));
            } else {
                s.push_str(&format!("Changed files: {shown}\n"));
            }
        }
        s
    }
}

fn outcome_text(outcome: RunOutcome) -> &'static str {
    match outcome {
        RunOutcome::Completed => "completed",
        RunOutcome::Cancelled => "stopped by the user before it was done",
        RunOutcome::Failed => "failed, not every task was done",
    }
}

fn status_text(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Done => "done",
        TaskStatus::Failed => "failed",
        TaskStatus::Skipped => "skipped",
        TaskStatus::Pending => "not started",
        TaskStatus::InProgress | TaskStatus::InReview => "unfinished",
    }
}

/// Whitespace collapsed to single spaces, cut to `max` characters.
fn one_line(text: &str, max: usize) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > max { format!("{}…", joined.chars().take(max).collect::<String>()) } else { joined }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Plan;

    fn task(id: &str, title: &str, status: TaskStatus, result: Option<&str>) -> Task {
        Task {
            id: id.into(),
            title: title.into(),
            description: String::new(),
            files: vec![],
            assignee: "coder".into(),
            status,
            attempts: 0,
            result: result.map(Into::into),
            review: None,
        }
    }

    fn board(tasks: Vec<Task>, files: &[&str]) -> Blackboard {
        Blackboard {
            plan: Some(Plan { goal: "Add a cart".into(), summary: "Model first, then the view.".into(), tasks }),
            messages: vec![],
            changed_files: files.iter().map(|f| f.to_string()).collect(),
        }
    }

    #[test]
    fn takes_plan_and_files_from_the_blackboard() {
        let bb = board(vec![task("T1", "Cart model", TaskStatus::Done, Some("Added src/cart.ts."))], &["src/cart.ts"]);
        let p = PreviousRun::new("Add a cart", RunOutcome::Completed, "✔ T1 Cart model", &bb, vec![]);
        assert_eq!(p.approach, "Model first, then the view.");
        assert_eq!(p.tasks.len(), 1);
        assert_eq!(p.changed_files, vec!["src/cart.ts"]);
    }

    #[test]
    fn describes_goal_outcome_tasks_and_files() {
        let bb = board(
            vec![
                task("T1", "Cart model", TaskStatus::Done, Some("Added src/cart.ts\nwith total().")),
                task("T2", "Cart view", TaskStatus::Failed, Some("Stopped: step limit reached.")),
                task("T3", "Docs", TaskStatus::Pending, None),
            ],
            &["src/cart.ts", "src/view.tsx"],
        );
        let text = PreviousRun::new("Add a cart", RunOutcome::Failed, "ignored", &bb, vec![]).describe();
        assert!(text.starts_with("Previous run (the request below continues it"), "{text}");
        assert!(text.contains("Request: Add a cart\n"), "{text}");
        assert!(text.contains("Outcome: failed"), "{text}");
        assert!(text.contains("Approach: Model first, then the view.\n"), "{text}");
        assert!(text.contains("- [T1] Cart model (done) -> Added src/cart.ts with total().\n"), "{text}");
        assert!(text.contains("- [T2] Cart view (failed) -> Stopped: step limit reached.\n"), "{text}");
        assert!(text.contains("- [T3] Docs (not started)\n"), "{text}");
        assert!(text.contains("Changed files: src/cart.ts, src/view.tsx\n"), "{text}");
        assert!(!text.contains("ignored"), "the summary repeats the tasks: {text}");
        assert!(!text.contains("Earlier requests"), "{text}");
    }

    #[test]
    fn without_a_plan_the_summary_is_the_result() {
        let p = PreviousRun::new(
            "Do it",
            RunOutcome::Cancelled,
            "The run was stopped before a plan was made.",
            &Blackboard::default(),
            vec![],
        );
        let text = p.describe();
        assert!(text.contains("Outcome: stopped by the user"), "{text}");
        assert!(text.contains("Result: The run was stopped before a plan was made.\n"), "{text}");
        assert!(text.contains("Changed files: none\n"), "{text}");
        assert!(!text.contains("Tasks:") && !text.contains("Approach:"), "{text}");
    }

    #[test]
    fn long_parts_are_cut() {
        let long = "word ".repeat(400);
        let files: Vec<String> = (0..25).map(|i| format!("src/file{i}.rs")).collect();
        let tasks: Vec<Task> = (1..=12).map(|i| task(&format!("T{i}"), &long, TaskStatus::Done, Some(&long))).collect();
        let mut bb = board(tasks, &[]);
        bb.changed_files = files.into_iter().collect();
        bb.plan.as_mut().unwrap().summary = long.clone();
        let earlier = vec![long.clone(), long.clone(), long.clone(), long.clone()];
        let p = PreviousRun::new(&long, RunOutcome::Completed, &long, &bb, earlier);
        let text = p.describe();
        assert!(text.chars().count() < 6_000, "{} characters", text.chars().count());
        assert!(text.contains("and 5 more\n"), "{text}");
        assert_eq!(text.matches("\n- word").count(), MAX_EARLIER_GOALS, "{text}");
        let request = text.lines().find(|l| l.starts_with("Request: ")).unwrap();
        assert_eq!(request.chars().count(), "Request: ".len() + GOAL_CHARS + 1);
        assert!(request.ends_with('…'));
    }

    #[test]
    fn the_goal_chain_keeps_the_latest_requests() {
        let earlier = vec!["one".to_string(), "two".to_string(), "three".to_string()];
        let p = PreviousRun::new("four", RunOutcome::Completed, "", &Blackboard::default(), earlier);
        assert_eq!(p.goal_chain(), vec!["two", "three", "four"]);
        let first = PreviousRun::new("only", RunOutcome::Completed, "", &Blackboard::default(), vec![]);
        assert_eq!(first.goal_chain(), vec!["only"]);
        let text = p.describe();
        assert!(text.contains("Earlier requests:\n- one\n- two\n- three\nRequest: four\n"), "{text}");
    }

    fn stopped_run() -> PreviousRun {
        let bb = board(
            vec![
                task("T1", "Cart model", TaskStatus::Done, Some("Added src/cart.ts.")),
                task("T2", "Cart view", TaskStatus::Failed, Some("Stopped: step limit reached.")),
                task("T3", "Discounts", TaskStatus::InProgress, None),
                task("T4", "Docs", TaskStatus::Pending, None),
            ],
            &["src/cart.ts"],
        );
        PreviousRun::new("Add a cart", RunOutcome::Failed, "", &bb, vec![])
    }

    #[test]
    fn open_tasks_carry_over_with_a_note_on_the_last_attempt() {
        let open = stopped_run().open_tasks();
        assert_eq!(open.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["T2", "T3", "T4"]);
        assert!(open.iter().all(|t| t.status == TaskStatus::Pending && t.result.is_none() && t.attempts == 0));
        assert_eq!(open[0].title, "Cart view");
        assert_eq!(open[0].description, "Earlier attempt: failed (Stopped: step limit reached.).");
        assert!(open[1].description.ends_with("Earlier attempt: stopped before it was done; changes made so far are in the project."));
        assert_eq!(open[2].description, "", "a task that never started gets no note");
    }

    #[test]
    fn a_task_carried_twice_keeps_one_note() {
        let mut failed = task("T2", "Cart view", TaskStatus::Failed, Some("Still failing."));
        failed.description = "Build the view.\n\nEarlier attempt: failed (Stopped: step limit reached.).".into();
        let p = PreviousRun::new("go on", RunOutcome::Failed, "", &board(vec![failed], &[]), vec![]);
        assert_eq!(p.open_tasks()[0].description, "Build the view.\n\nEarlier attempt: failed (Still failing.).");
    }

    #[test]
    fn the_planner_is_told_which_tasks_carry_over() {
        let p = stopped_run();
        assert_eq!(p.last_task_number(), 4);
        let text = p.describe();
        assert!(text.contains("The open tasks (T2, T3, T4) carry over into this run"), "{text}");
        assert!(text.contains("submit an empty task list"), "{text}");
        let done = PreviousRun::new("x", RunOutcome::Completed, "", &board(vec![task("T1", "a", TaskStatus::Done, None)], &[]), vec![]);
        assert!(done.open_tasks().is_empty());
        assert!(!done.describe().contains("carry over"));
    }
}
