use crate::{disconnect_runtime, grok_prompt_active, GrokRuntime};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub(crate) struct AppUpdateRuntime {
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateInfo {
    current_version: String,
    version: String,
    body: Option<String>,
    date: Option<String>,
}

impl From<&Update> for AppUpdateInfo {
    fn from(update: &Update) -> Self {
        Self {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            body: update.body.clone(),
            date: update.date.map(|date| date.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    stage: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub(crate) async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateRuntime>,
) -> Result<Option<AppUpdateInfo>, String> {
    if state.installing.load(Ordering::Acquire) {
        return Err("An update is already being installed.".to_string());
    }

    let update = app
        .updater()
        .map_err(|error| format!("Failed to prepare the updater: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Failed to check for updates: {error}"))?;
    let info = update.as_ref().map(AppUpdateInfo::from);
    *state.pending.lock().await = update;
    Ok(info)
}

#[tauri::command]
pub(crate) async fn install_app_update(
    app: AppHandle,
    grok: State<'_, GrokRuntime>,
    state: State<'_, AppUpdateRuntime>,
) -> Result<(), String> {
    if state
        .installing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("An update is already being installed.".to_string());
    }

    let result = async {
        if grok_prompt_active(&grok).await {
            return Err("Stop the active turn before updating.".to_string());
        }

        let update = state
            .pending
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Check for updates before installing one.".to_string())?;

        let _ = app.emit(
            "groky://update-progress",
            AppUpdateProgress {
                stage: "downloading",
                downloaded: 0,
                total: None,
            },
        );

        let progress_app = app.clone();
        let finished_app = app.clone();
        let mut downloaded = 0_u64;
        let bytes = update
            .download(
                move |chunk_length, total| {
                    downloaded = downloaded.saturating_add(chunk_length as u64);
                    let _ = progress_app.emit(
                        "groky://update-progress",
                        AppUpdateProgress {
                            stage: "downloading",
                            downloaded,
                            total,
                        },
                    );
                },
                move || {
                    let _ = finished_app.emit(
                        "groky://update-progress",
                        AppUpdateProgress {
                            stage: "downloaded",
                            downloaded: 0,
                            total: None,
                        },
                    );
                },
            )
            .await
            .map_err(|error| format!("Failed to download the update: {error}"))?;

        if grok_prompt_active(&grok).await {
            return Err("Stop the active turn before updating.".to_string());
        }

        let package_size = bytes.len() as u64;
        let _ = app.emit(
            "groky://update-progress",
            AppUpdateProgress {
                stage: "installing",
                downloaded: package_size,
                total: Some(package_size),
            },
        );
        disconnect_runtime(&grok).await;
        update
            .install(&bytes)
            .map_err(|error| format!("Failed to install the update: {error}"))?;
        Ok(())
    }
    .await;

    state.installing.store(false, Ordering::Release);
    result?;
    *state.pending.lock().await = None;
    app.restart()
}
