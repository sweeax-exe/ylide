//! The only door to the internet. Ylide makes exactly four kinds of outbound
//! requests, each switchable in the settings and each recorded in a log the
//! user can read: registry updates, model downloads, runtime downloads and
//! update checks (with the installer download that follows one).
//! Requests never carry user identifiers.

use crate::error::{AppError, AppResult};
use crate::settings::NetworkSettings;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use ts_rs::TS;

/// Sent with every request: the product name and version, nothing else.
pub const USER_AGENT: &str = concat!("Ylide/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NetPurpose {
    Registry,
    ModelDownload,
    RuntimeDownload,
    UpdateCheck,
    UpdateDownload,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NetworkLogEntry {
    #[ts(type = "number")]
    pub at_unix_ms: u64,
    pub purpose: NetPurpose,
    pub url: String,
    pub outcome: String,
}

pub struct NetworkGate {
    client: reqwest::Client,
    log: Mutex<VecDeque<NetworkLogEntry>>,
    app: Mutex<Option<AppHandle>>,
}

const LOG_LIMIT: usize = 500;

impl NetworkGate {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(10))
            .https_only(true)
            .build()
            .expect("static HTTP client configuration");
        Self {
            client,
            log: Mutex::new(VecDeque::new()),
            app: Mutex::new(None),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    pub fn client(&self) -> reqwest::Client {
        self.client.clone()
    }

    /// Fails with `network_disabled` when the user switched this purpose off.
    pub fn check(&self, settings: &NetworkSettings, purpose: NetPurpose) -> AppResult<()> {
        let allowed = match purpose {
            NetPurpose::Registry => settings.allow_registry_updates && !settings.registry_url.trim().is_empty(),
            NetPurpose::ModelDownload => settings.allow_model_downloads,
            NetPurpose::RuntimeDownload => settings.allow_runtime_downloads,
            NetPurpose::UpdateCheck | NetPurpose::UpdateDownload => settings.allow_update_checks,
        };
        if allowed {
            Ok(())
        } else {
            Err(AppError::new("network_disabled", format!("{purpose:?} is disabled in the network settings")))
        }
    }

    pub fn record(&self, purpose: NetPurpose, url: &str, outcome: impl ToString) {
        let entry = NetworkLogEntry {
            at_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            purpose,
            url: url.to_string(),
            outcome: outcome.to_string(),
        };
        {
            let mut log = self.log.lock().unwrap();
            if log.len() == LOG_LIMIT {
                log.pop_front();
            }
            log.push_back(entry.clone());
        }
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            let _ = app.emit("network://log", &entry);
        }
    }

    pub fn entries(&self) -> Vec<NetworkLogEntry> {
        self.log.lock().unwrap().iter().cloned().collect()
    }
}

impl Default for NetworkGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_contains_no_identifiers() {
        assert!(USER_AGENT.starts_with("Ylide/"));
        assert!(!USER_AGENT.contains('@'), "never an e-mail address");
        assert!(!USER_AGENT.contains(' '), "only product/version");
        let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
        if !user.is_empty() {
            assert!(!USER_AGENT.to_lowercase().contains(&user.to_lowercase()));
        }
    }

    #[test]
    fn purposes_can_be_switched_off() {
        let gate = NetworkGate::new();
        let mut s = NetworkSettings::default();
        assert!(gate.check(&s, NetPurpose::ModelDownload).is_ok());
        s.allow_model_downloads = false;
        assert_eq!(gate.check(&s, NetPurpose::ModelDownload).unwrap_err().code, "network_disabled");
        s.registry_url.clear();
        assert!(gate.check(&s, NetPurpose::Registry).is_err(), "an empty URL disables registry updates");
        assert!(gate.check(&s, NetPurpose::UpdateCheck).is_ok());
        s.allow_update_checks = false;
        assert!(gate.check(&s, NetPurpose::UpdateCheck).is_err());
        assert!(gate.check(&s, NetPurpose::UpdateDownload).is_err(), "no installer download without update checks");
    }

    #[test]
    fn log_is_bounded() {
        let gate = NetworkGate::new();
        for i in 0..(LOG_LIMIT + 5) {
            gate.record(NetPurpose::Registry, &format!("https://x/{i}"), "200");
        }
        let e = gate.entries();
        assert_eq!(e.len(), LOG_LIMIT);
        assert_eq!(e.last().unwrap().url, format!("https://x/{}", LOG_LIMIT + 4));
    }
}
