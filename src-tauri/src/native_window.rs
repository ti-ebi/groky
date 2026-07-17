#[tauri::command]
pub(crate) fn configure_native_titlebar(
    window: tauri::WebviewWindow,
) -> Result<Option<f64>, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton};

        const MINIMUM_TITLEBAR_HEIGHT: f64 = 40.0;

        let ns_window_ptr = window
            .ns_window()
            .map_err(|error| format!("Failed to access the native window: {error}"))?
            as *mut NSWindow;
        let ns_window = unsafe { &*ns_window_ptr };
        let window_frame = ns_window.frame();
        let native_height = window_frame.size.height - ns_window.contentLayoutRect().size.height;
        let height = native_height.max(MINIMUM_TITLEBAR_HEIGHT);

        if let Some(close_button) = ns_window.standardWindowButton(NSWindowButton::CloseButton) {
            let button_parent = unsafe { close_button.superview() };
            let titlebar_container = button_parent
                .as_ref()
                .and_then(|parent| unsafe { parent.superview() });

            if let Some(container) = titlebar_container {
                let mut container_frame = container.frame();
                container_frame.size.height = height;
                container_frame.origin.y = window_frame.size.height - height;
                container.setFrame(container_frame);

                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    let Some(button) = ns_window.standardWindowButton(kind) else {
                        continue;
                    };
                    let Some(parent) = (unsafe { button.superview() }) else {
                        continue;
                    };
                    let parent_frame = parent.frame();
                    let mut button_frame = button.frame();
                    button_frame.origin.y =
                        height / 2.0 - parent_frame.origin.y - button_frame.size.height / 2.0;
                    button.setFrameOrigin(button_frame.origin);
                }
            }
        }

        return Ok((height.is_finite() && height > 0.0 && height <= 96.0).then_some(height));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(None)
    }
}
