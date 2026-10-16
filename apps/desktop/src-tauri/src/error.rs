//! Errors returned to the UI as `{ code, message }`. Codes are stable and
//! translated by the frontend; messages carry technical detail.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

macro_rules! from_error {
    ($ty:ty, $code:expr) => {
        impl From<$ty> for AppError {
            fn from(e: $ty) -> Self {
                AppError::new($code, e)
            }
        }
    };
}

from_error!(std::io::Error, "io");
from_error!(serde_json::Error, "json");
from_error!(workspace::WorkspaceError, "workspace");
from_error!(registry::RegistryError, "registry");
from_error!(downloader::DownloadError, "download");
from_error!(inference::LlmError, "model");
from_error!(inference::ServerError, "server");
from_error!(reqwest::Error, "network");
from_error!(tauri::Error, "tauri");
