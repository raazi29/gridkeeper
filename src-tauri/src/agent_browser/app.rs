//! Tauri wiring: create the hub from the app context (data folder, session roots, ports, events).

use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use super::hub::{FrameSink, Hub, HubOptions, UiEvent, install_global};
use super::model::{EVT_ACTIVITY, EVT_STATE};

/// Called once from `lib.rs` setup, after `AppCtx` is managed.
pub fn install(app: &AppHandle) {
    let Some(ctx) = app.try_state::<crate::state::AppCtx>() else {
        tracing::warn!("agent browser: no app context");
        return;
    };
    let roots_src = Arc::clone(&ctx.sessions);
    let ports_src = Arc::clone(&ctx.sessions);
    let existing: Vec<String> = ctx.store.get().sessions.into_iter().map(|m| m.id).collect();
    let emitter = app.clone();
    let hub = Hub::new(HubOptions {
        data_dir: ctx.paths.data_dir.clone(),
        exe: std::env::current_exe().ok(),
        emit: Arc::new(move |ev| {
            let r = match ev {
                UiEvent::State(s) => emitter.emit(EVT_STATE, s),
                UiEvent::Activity(a) => emitter.emit(EVT_ACTIVITY, a),
            };
            if let Err(e) = r {
                tracing::warn!(error = %e, "could not emit an agent browser event");
            }
        }),
        roots: Arc::new(move || roots_src.root_pids()),
        dev_ports: Arc::new(move || {
            crate::ports::session_ports(&ports_src.root_pids()).into_iter().flat_map(|s| s.ports.into_iter().map(|p| p.port)).collect()
        }),
        existing_sessions: Some(existing),
        serve: true,
    });
    install_global(hub);
}

/// Screencast frames to the Agent browser view (raw binary, like terminal output).
pub struct ChannelSink(pub Channel<InvokeResponseBody>);

impl FrameSink for ChannelSink {
    fn send(&self, bytes: Vec<u8>) -> bool {
        self.0.send(InvokeResponseBody::Raw(bytes)).is_ok()
    }
}
