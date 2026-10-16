//! Ylide desktop app: wires the core crates into a Tauri application.

mod agents;
mod chat;
mod chats;
mod commands;
#[cfg(test)]
mod e2e;
mod error;
mod last_run;
mod logging;
mod migration;
mod models;
mod network;
mod paths;
mod registry_service;
mod runtime;
mod settings;
mod signing;
mod state;
mod updates;
mod watcher;

use state::AppState;
use tauri::{Manager, RunEvent};

pub fn run() {
    logging::init();

    // Moves the folders of the old identifier before Tauri creates any folder
    // (the WebView2 profile included); where that fails, Tauri keeps using the
    // old ones for this run.
    let mut context = tauri::generate_context!();
    let identifier = context.config().identifier.clone();
    // A second start only hands over to the running instance (single-instance
    // plugin) and must not touch its folders or its log.
    let first_instance = !migration::app_running(&identifier);
    if context.config().app.app_directories_override.is_none() {
        context.config_mut().app.app_directories_override = migration::migrate_app_dirs(&identifier);
    }
    // The log goes into the local data folder this run uses: the new one once
    // the migration is done with it, or the old one it kept.
    let log_dir = match &context.config().app.app_directories_override {
        Some(tauri::utils::config::AppDirectoriesOverride::Directories(o)) => o.local_data.as_ref().map(|d| d.join("logs")).or_else(|| logging::log_dir(&identifier)),
        _ => logging::log_dir(&identifier),
    };
    if first_instance
        && let Some(dir) = log_dir
        && let Err(e) = logging::attach_file(&dir)
    {
        tracing::warn!("no log file: {e}");
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = paths::AppPaths::resolve(app.handle())?;
            let state = AppState::new(paths);
            state.net.attach(app.handle().clone());
            app.manage(state);
            startup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_defaults,
            commands::settings_set,
            commands::network_log,
            commands::hardware_probe,
            commands::registry_info,
            commands::registry_refresh,
            commands::update_check,
            commands::update_download,
            commands::update_launch,
            commands::recommend,
            commands::models_installed,
            commands::downloads,
            commands::model_download,
            commands::model_pause,
            commands::model_cancel,
            commands::model_delete,
            commands::model_import,
            commands::runtime_status,
            commands::runtime_install,
            commands::server_start,
            commands::server_stop,
            commands::server_info,
            commands::server_logs,
            commands::workspace_open,
            commands::workspace_current,
            commands::workspace_close,
            commands::fs_list_dir,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_create,
            commands::fs_rename,
            commands::fs_delete,
            commands::fs_search,
            commands::fs_find_files,
            commands::fs_exists,
            commands::fs_find_symbols,
            commands::context_preview,
            commands::chat_send,
            commands::chats_list,
            commands::chat_load,
            commands::chat_save,
            commands::chat_delete,
            commands::chats_delete_all,
            commands::request_cancel,
            commands::inline_edit,
            commands::agent_start,
            commands::agent_approve,
            commands::agent_answer,
            commands::agent_control,
            commands::agent_intervene,
            commands::agent_last_run,
            commands::checkpoints_list,
            commands::checkpoint_restore,
        ])
        .build(context)
        .expect("error while building the Ylide application");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Free VRAM right away; the job object would also kill the server.
            let state = handle.state::<AppState>();
            let runtime = state.runtime.clone();
            let handle = handle.clone();
            tauri::async_runtime::block_on(async move { runtime.stop(&handle).await });
        }
    });
}

/// Background work after the window is up: probe hardware, refresh the
/// registry and start the chosen model. The UI reopens the last project.
fn startup(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let dir = state.models.dir();
        if let Ok(hw) = tokio::task::spawn_blocking(move || hardware::probe(Some(&dir))).await {
            *state.hardware.write().unwrap() = Some(hw);
        }
        let settings = state.settings();
        let refresh_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = registry_service::refresh(&refresh_app).await;
            tracing::info!("registry refresh: {outcome:?}");
        });
        if settings.onboarding_done && settings.models.autostart {
            let result = if settings.endpoint.enabled {
                state.runtime.use_external(&app, &settings).await.map(|_| ())
            } else {
                commands::server_start(app.clone(), state.clone(), None).await.map(|_| ())
            };
            if let Err(e) = result {
                tracing::warn!("autostart failed: {e}");
            }
        }
    });
}
