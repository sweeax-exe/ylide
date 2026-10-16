//! Shares the parallel slots of one llama-server between chat, inline edits and agents.
//!
//! * At most `slots` requests run at once (llama-server `--parallel`); the rest queue.
//! * Interactive requests (chat, inline edit) overtake agent work, which
//!   overtakes background work (indexing). FIFO within a priority.
//! * Callers can name a preferred slot. Agents keep "their" slot so llama-server
//!   can reuse the KV cache of their (long, mostly unchanged) prompt prefix.
//! * A [`SlotGuard`] frees its slot on drop, including when a queued request is
//!   cancelled after it was granted a slot but before it ran.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Priority {
    Interactive = 0,
    Agent = 1,
    Background = 2,
}

struct Waiter {
    priority: Priority,
    seq: u64,
    preferred: Option<usize>,
    label: String,
    tx: oneshot::Sender<SlotGuard>,
}

struct State {
    generation: u64,
    busy: Vec<Option<String>>,
    queue: Vec<Waiter>,
    seq: u64,
}

#[derive(Clone)]
pub struct Scheduler {
    state: Arc<Mutex<State>>,
}

/// Holds one slot. Dropping it hands the slot to the next waiter.
pub struct SlotGuard {
    slot: usize,
    generation: u64,
    state: Option<Arc<Mutex<State>>>,
}

impl SlotGuard {
    pub fn slot(&self) -> usize {
        self.slot
    }
}

impl std::fmt::Debug for SlotGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlotGuard").field("slot", &self.slot).finish()
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Some(state) = self.state.take() {
            release(&state, self.slot, self.generation);
        }
    }
}

fn release(state: &Arc<Mutex<State>>, slot: usize, generation: u64) {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    if generation != s.generation || slot >= s.busy.len() {
        return; // slot belongs to a server configuration that no longer exists
    }
    s.busy[slot] = None;
    loop {
        let Some(best) = pick_waiter(&s.queue, slot) else { return };
        let waiter = s.queue.swap_remove(best);
        s.busy[slot] = Some(waiter.label.clone());
        let guard = SlotGuard {
            slot,
            generation: s.generation,
            state: Some(state.clone()),
        };
        match waiter.tx.send(guard) {
            Ok(()) => return,
            Err(mut unwanted) => {
                // The waiter gave up; defuse the guard (we hold the lock) and try the next one.
                unwanted.state = None;
                s.busy[slot] = None;
            }
        }
    }
}

/// Highest priority first; within it prefer a waiter that wants exactly this
/// slot (cache reuse), otherwise the one that has waited longest.
fn pick_waiter(queue: &[Waiter], slot: usize) -> Option<usize> {
    let best_priority = queue.iter().map(|w| w.priority).min()?;
    let candidates = queue.iter().enumerate().filter(|(_, w)| w.priority == best_priority);
    candidates
        .clone()
        .filter(|(_, w)| w.preferred == Some(slot))
        .min_by_key(|(_, w)| w.seq)
        .or_else(|| candidates.min_by_key(|(_, w)| w.seq))
        .map(|(i, _)| i)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SchedulerSnapshot {
    /// Label of the request occupying each slot, `null` when idle.
    pub slots: Vec<Option<String>>,
    pub queued: Vec<QueuedRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueuedRequest {
    pub label: String,
    pub priority: Priority,
}

impl Scheduler {
    pub fn new(slots: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                generation: 0,
                busy: vec![None; slots.max(1)],
                queue: Vec::new(),
                seq: 0,
            })),
        }
    }

    /// Waits for a free slot. Cancel-safe: dropping the future never leaks a slot.
    pub async fn acquire(&self, priority: Priority, preferred: Option<usize>, label: impl Into<String>) -> SlotGuard {
        let label = label.into();
        let rx = {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let free = preferred
                .filter(|p| *p < s.busy.len() && s.busy[*p].is_none())
                .or_else(|| s.busy.iter().position(Option::is_none));
            if let Some(slot) = free {
                s.busy[slot] = Some(label);
                return SlotGuard {
                    slot,
                    generation: s.generation,
                    state: Some(self.state.clone()),
                };
            }
            let (tx, rx) = oneshot::channel();
            s.seq += 1;
            let seq = s.seq;
            s.queue.push(Waiter {
                priority,
                seq,
                preferred,
                label: label.clone(),
                tx,
            });
            rx
        };
        match rx.await {
            Ok(guard) => guard,
            // Only happens when the scheduler is reset while we wait: retry on the new configuration.
            Err(_) => Box::pin(self.acquire(priority, preferred, label)).await,
        }
    }

    /// Reconfigures for a restarted server with `slots` slots. Running guards
    /// become inert; queued requests are re-queued on the new configuration.
    pub fn reset(&self, slots: usize) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.generation += 1;
        s.busy = vec![None; slots.max(1)];
        // Dropping the senders makes waiting `acquire` calls retry.
        s.queue.clear();
    }

    pub fn snapshot(&self) -> SchedulerSnapshot {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut queued: Vec<_> = s.queue.iter().map(|w| (w.priority, w.seq, w.label.clone())).collect();
        queued.sort();
        SchedulerSnapshot {
            slots: s.busy.clone(),
            queued: queued
                .into_iter()
                .map(|(priority, _, label)| QueuedRequest { label, priority })
                .collect(),
        }
    }

    pub fn slot_count(&self) -> usize {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).busy.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn limits_concurrency_to_slot_count() {
        let s = Scheduler::new(2);
        let a = s.acquire(Priority::Agent, None, "a").await;
        let b = s.acquire(Priority::Agent, None, "b").await;
        assert_ne!(a.slot(), b.slot());
        assert!(timeout(Duration::from_millis(50), s.acquire(Priority::Agent, None, "c")).await.is_err());
        drop(a);
        let c = timeout(Duration::from_millis(200), s.acquire(Priority::Agent, None, "c")).await.unwrap();
        assert_eq!(c.slot(), 0);
        drop((b, c));
        assert_eq!(s.snapshot().slots, vec![None, None]);
    }

    #[tokio::test]
    async fn interactive_requests_overtake_agents() {
        let s = Scheduler::new(1);
        let held = s.acquire(Priority::Agent, None, "running").await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        for (label, prio) in [("bg", Priority::Background), ("agent", Priority::Agent), ("chat", Priority::Interactive)] {
            let s = s.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let g = s.acquire(prio, None, label).await;
                tx.send(label).unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
                drop(g);
            });
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let snap = s.snapshot();
        assert_eq!(snap.queued.iter().map(|q| q.label.as_str()).collect::<Vec<_>>(), vec!["chat", "agent", "bg"]);
        drop(held);
        let order = vec![rx.recv().await.unwrap(), rx.recv().await.unwrap(), rx.recv().await.unwrap()];
        assert_eq!(order, vec!["chat", "agent", "bg"]);
    }

    #[tokio::test]
    async fn preferred_slot_is_honoured_when_free() {
        let s = Scheduler::new(3);
        let g = s.acquire(Priority::Agent, Some(2), "reviewer").await;
        assert_eq!(g.slot(), 2);
        let other = s.acquire(Priority::Agent, Some(2), "coder").await;
        assert_ne!(other.slot(), 2, "busy preferred slot falls back to any free slot");
    }

    #[tokio::test]
    async fn waiter_preferring_freed_slot_wins_within_priority() {
        let s = Scheduler::new(2);
        let g0 = s.acquire(Priority::Agent, Some(0), "x").await;
        let _g1 = s.acquire(Priority::Agent, Some(1), "y").await;
        let s1 = s.clone();
        let first = tokio::spawn(async move { s1.acquire(Priority::Agent, Some(1), "wants-1").await.slot() });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let s2 = s.clone();
        let second = tokio::spawn(async move { s2.acquire(Priority::Agent, Some(0), "wants-0").await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        drop(g0);
        let second_guard = timeout(Duration::from_millis(200), second).await.unwrap().unwrap();
        assert_eq!(second_guard.slot(), 0, "the waiter that prefers the freed slot gets it");
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!first.is_finished(), "older waiter keeps waiting for its slot");
        drop(second_guard);
        assert_eq!(timeout(Duration::from_millis(200), first).await.unwrap().unwrap(), 0);
    }

    #[tokio::test]
    async fn cancelled_waiters_do_not_leak_slots() {
        let s = Scheduler::new(1);
        let held = s.acquire(Priority::Agent, None, "held").await;
        let waiting = {
            let s = s.clone();
            tokio::spawn(async move { s.acquire(Priority::Agent, None, "gives-up").await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        waiting.abort();
        let _ = waiting.await;
        drop(held);
        let g = timeout(Duration::from_millis(200), s.acquire(Priority::Agent, None, "next")).await.unwrap();
        assert_eq!(g.slot(), 0);
        assert!(s.snapshot().queued.is_empty());
    }

    #[tokio::test]
    async fn reset_makes_old_guards_inert() {
        let s = Scheduler::new(1);
        let old = s.acquire(Priority::Agent, None, "old").await;
        s.reset(2);
        let a = s.acquire(Priority::Agent, None, "a").await;
        let b = s.acquire(Priority::Agent, None, "b").await;
        drop(old); // must not free slot 0 of the new configuration
        assert_eq!(s.snapshot().slots, vec![Some("a".into()), Some("b".into())]);
        drop((a, b));
    }

    #[tokio::test]
    async fn waiters_survive_reset() {
        let s = Scheduler::new(1);
        let _held = s.acquire(Priority::Agent, None, "held").await;
        let s2 = s.clone();
        let waiting = tokio::spawn(async move { s2.acquire(Priority::Agent, None, "w").await.slot() });
        tokio::time::sleep(Duration::from_millis(10)).await;
        s.reset(1);
        assert_eq!(timeout(Duration::from_millis(200), waiting).await.unwrap().unwrap(), 0);
    }
}
