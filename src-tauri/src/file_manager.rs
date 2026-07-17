use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{async_runtime, AppHandle, Emitter, State};

use super::{inspect_attachment_paths, FileAttachment, GrokRuntime};

const MAX_DIRECTORY_ENTRIES: usize = 5_000;
const MAX_RELATIVE_PATH_BYTES: usize = 8 * 1024;
const MAX_TEXT_PREVIEW_BYTES: usize = 512 * 1024;
const MAX_BINARY_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FONT_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
const WORKSPACE_CHANGED_EVENT: &str = "groky://workspace-changed";

#[derive(Default)]
pub(crate) struct WorkspaceWatcherRuntime {
    watchers: Mutex<HashMap<String, (String, RecommendedWatcher)>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangedEvent {
    session_id: String,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkspaceFileKind {
    Directory,
    File,
    Symlink,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileEntry {
    name: String,
    path: String,
    kind: WorkspaceFileKind,
    size: Option<u64>,
    modified_at: Option<i64>,
    hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDirectoryListing {
    path: String,
    entries: Vec<WorkspaceFileEntry>,
    truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkspacePreviewKind {
    Font,
    Image,
    Pdf,
    Text,
    Unsupported,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFilePreview {
    path: String,
    name: String,
    kind: WorkspacePreviewKind,
    mime_type: Option<String>,
    size: u64,
    content: Option<String>,
    data_url: Option<String>,
    truncated: bool,
}

async fn session_working_directory(
    state: &GrokRuntime,
    session_id: &str,
) -> Result<PathBuf, String> {
    state
        .inner
        .lock()
        .await
        .sessions
        .get(session_id)
        .map(|session| PathBuf::from(&session.working_directory))
        .ok_or_else(|| "That session is not active in Groky.".to_string())
}

fn normalize_relative_path(path: &str) -> Result<PathBuf, String> {
    if path.len() > MAX_RELATIVE_PATH_BYTES {
        return Err("The requested file path is too long.".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("The requested file path is invalid.".to_string());
            }
        }
    }
    Ok(normalized)
}

fn portable_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn workspace_event_paths(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut relative_paths = paths
        .iter()
        .filter_map(|path| path.strip_prefix(root).ok())
        .map(portable_relative_path)
        .collect::<Vec<_>>();
    relative_paths.sort();
    relative_paths.dedup();
    relative_paths
}

fn open_folder_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "macos")]
    command.arg(path);

    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "linux")]
    command.arg(path);

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return Err("Opening folders is not supported on this platform.".to_string());

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "The folder could not be opened in the system file manager.".to_string())
}

fn canonical_workspace_root(root: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The session working directory is unavailable.".to_string())?;
    if !root.is_dir() {
        return Err("The session working directory is not a folder.".to_string());
    }
    Ok(root)
}

fn resolve_workspace_path(root: &Path, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_workspace_root(root)?;
    let relative_path = normalize_relative_path(relative_path)?;
    let target = root
        .join(&relative_path)
        .canonicalize()
        .map_err(|_| "The requested file is no longer available.".to_string())?;
    if !target.starts_with(&root) {
        return Err("The requested file is outside the session working directory.".to_string());
    }
    Ok((target, relative_path))
}

fn modified_at_millis(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

fn kind_rank(kind: WorkspaceFileKind) -> u8 {
    match kind {
        WorkspaceFileKind::Directory => 0,
        WorkspaceFileKind::File => 1,
        WorkspaceFileKind::Symlink => 2,
    }
}

fn compare_entries(left: &WorkspaceFileEntry, right: &WorkspaceFileEntry) -> Ordering {
    kind_rank(left.kind)
        .cmp(&kind_rank(right.kind))
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        .then_with(|| left.name.cmp(&right.name))
}

fn list_workspace_directory(
    root: &Path,
    relative_path: &str,
) -> Result<WorkspaceDirectoryListing, String> {
    let (directory, normalized_relative_path) = resolve_workspace_path(root, relative_path)?;
    if !directory.is_dir() {
        return Err("The requested file is not a folder.".to_string());
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    let children = fs::read_dir(&directory)
        .map_err(|_| "The requested folder could not be read.".to_string())?;
    for child in children {
        if entries.len() == MAX_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }

        let child = child.map_err(|_| "A folder entry could not be read.".to_string())?;
        let file_type = child
            .file_type()
            .map_err(|_| "A folder entry could not be inspected.".to_string())?;
        let kind = if file_type.is_symlink() {
            WorkspaceFileKind::Symlink
        } else if file_type.is_dir() {
            WorkspaceFileKind::Directory
        } else {
            WorkspaceFileKind::File
        };
        let metadata = child
            .metadata()
            .map_err(|_| "A folder entry could not be inspected.".to_string())?;
        let name = child.file_name().to_string_lossy().into_owned();
        let child_relative_path = normalized_relative_path.join(&name);

        entries.push(WorkspaceFileEntry {
            hidden: name.starts_with('.'),
            name,
            path: portable_relative_path(&child_relative_path),
            kind,
            size: (kind == WorkspaceFileKind::File).then_some(metadata.len()),
            modified_at: modified_at_millis(&metadata),
        });
    }
    entries.sort_by(compare_entries);

    Ok(WorkspaceDirectoryListing {
        path: portable_relative_path(&normalized_relative_path),
        entries,
        truncated,
    })
}

fn binary_preview_kind(mime_type: &str) -> Option<WorkspacePreviewKind> {
    if matches!(
        mime_type,
        "image/avif"
            | "image/bmp"
            | "image/gif"
            | "image/jpeg"
            | "image/png"
            | "image/svg+xml"
            | "image/webp"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    ) {
        Some(WorkspacePreviewKind::Image)
    } else if mime_type == "application/pdf" {
        Some(WorkspacePreviewKind::Pdf)
    } else if mime_type.starts_with("font/")
        || matches!(
            mime_type,
            "application/font-sfnt"
                | "application/font-woff"
                | "application/vnd.ms-fontobject"
                | "application/x-font-opentype"
                | "application/x-font-truetype"
        )
    {
        Some(WorkspacePreviewKind::Font)
    } else {
        None
    }
}

fn is_probably_text(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    let Ok(content) = std::str::from_utf8(bytes) else {
        return false;
    };
    let character_count = content.chars().count();
    if character_count == 0 {
        return true;
    }
    let unexpected_controls = content
        .chars()
        .filter(|character| {
            character.is_control() && !matches!(character, '\n' | '\r' | '\t' | '\u{000C}')
        })
        .count();
    unexpected_controls * 100 <= character_count
}

fn is_unsupported_media_preview(file: &Path, mime_type: &str) -> bool {
    if mime_type.starts_with("audio/") {
        return true;
    }
    if !mime_type.starts_with("video/") {
        return false;
    }

    // `.ts` is shared by TypeScript and MPEG transport streams. MIME databases
    // classify the extension as video, so let UTF-8 content detection distinguish
    // TypeScript source from actual binary transport-stream data.
    let ambiguous_typescript_mime = file
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ts"));
    !ambiguous_typescript_mime
}

fn unsupported_preview(
    relative_path: &Path,
    file: &Path,
    mime_type: Option<String>,
    size: u64,
    truncated: bool,
) -> WorkspaceFilePreview {
    WorkspaceFilePreview {
        path: portable_relative_path(relative_path),
        name: file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "File".to_string()),
        kind: WorkspacePreviewKind::Unsupported,
        mime_type,
        size,
        content: None,
        data_url: None,
        truncated,
    }
}

fn preview_workspace_file(
    root: &Path,
    relative_path: &str,
) -> Result<WorkspaceFilePreview, String> {
    let (file, normalized_relative_path) = resolve_workspace_path(root, relative_path)?;
    if !file.is_file() {
        return Err("The requested path is not a file.".to_string());
    }

    let metadata = file
        .metadata()
        .map_err(|_| "The requested file could not be inspected.".to_string())?;
    let size = metadata.len();
    let mime_type = mime_guess::from_path(&file).first_raw().map(str::to_string);
    let preview_path = portable_relative_path(&normalized_relative_path);
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "File".to_string());

    if let Some(kind) = mime_type.as_deref().and_then(binary_preview_kind) {
        let maximum_size = if kind == WorkspacePreviewKind::Font {
            MAX_FONT_PREVIEW_BYTES
        } else {
            MAX_BINARY_PREVIEW_BYTES
        };
        if size > maximum_size {
            return Ok(unsupported_preview(
                &normalized_relative_path,
                &file,
                mime_type,
                size,
                true,
            ));
        }
        let bytes = fs::read(&file)
            .map_err(|_| "The requested file could not be read for preview.".to_string())?;
        let data_url = format!(
            "data:{};base64,{}",
            mime_type.as_deref().unwrap_or("application/octet-stream"),
            BASE64_STANDARD.encode(bytes)
        );
        return Ok(WorkspaceFilePreview {
            path: preview_path,
            name,
            kind,
            mime_type,
            size,
            content: None,
            data_url: Some(data_url),
            truncated: false,
        });
    }

    if mime_type
        .as_deref()
        .is_some_and(|mime_type| is_unsupported_media_preview(&file, mime_type))
    {
        return Ok(unsupported_preview(
            &normalized_relative_path,
            &file,
            mime_type,
            size,
            false,
        ));
    }

    let preview_capacity = usize::try_from(size)
        .unwrap_or(MAX_TEXT_PREVIEW_BYTES)
        .min(MAX_TEXT_PREVIEW_BYTES);
    let mut bytes = Vec::with_capacity(preview_capacity);
    fs::File::open(&file)
        .map_err(|_| "The requested file could not be read.".to_string())?
        .take((MAX_TEXT_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "The requested file could not be read.".to_string())?;
    let truncated = bytes.len() > MAX_TEXT_PREVIEW_BYTES;
    bytes.truncate(MAX_TEXT_PREVIEW_BYTES);
    if !is_probably_text(&bytes) {
        return Ok(unsupported_preview(
            &normalized_relative_path,
            &file,
            mime_type,
            size,
            false,
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "This text file uses an encoding that cannot be previewed yet.".to_string())?;

    Ok(WorkspaceFilePreview {
        path: preview_path,
        name,
        kind: WorkspacePreviewKind::Text,
        mime_type,
        size,
        content: Some(content),
        data_url: None,
        truncated,
    })
}

#[tauri::command]
pub(crate) async fn workspace_list_directory(
    state: State<'_, GrokRuntime>,
    session_id: String,
    path: String,
) -> Result<WorkspaceDirectoryListing, String> {
    let root = session_working_directory(&state, &session_id).await?;
    async_runtime::spawn_blocking(move || list_workspace_directory(&root, &path))
        .await
        .map_err(|_| "The requested folder could not be read.".to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_inspect_attachment(
    state: State<'_, GrokRuntime>,
    session_id: String,
    path: String,
) -> Result<FileAttachment, String> {
    let root = session_working_directory(&state, &session_id).await?;
    async_runtime::spawn_blocking(move || {
        let (path, _) = resolve_workspace_path(&root, &path)?;
        let mut attachments = inspect_attachment_paths(vec![path])?;
        attachments
            .pop()
            .ok_or_else(|| "The requested file could not be attached.".to_string())
    })
    .await
    .map_err(|_| "The requested file could not be attached.".to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_preview_file(
    state: State<'_, GrokRuntime>,
    session_id: String,
    path: String,
) -> Result<WorkspaceFilePreview, String> {
    let root = session_working_directory(&state, &session_id).await?;
    async_runtime::spawn_blocking(move || preview_workspace_file(&root, &path))
        .await
        .map_err(|_| "The requested file could not be previewed.".to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_open_folder(
    state: State<'_, GrokRuntime>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let root = session_working_directory(&state, &session_id).await?;
    async_runtime::spawn_blocking(move || {
        let (folder, _) = resolve_workspace_path(&root, &path)?;
        if !folder.is_dir() {
            return Err("The requested path is not a folder.".to_string());
        }
        open_folder_in_file_manager(&folder)
    })
    .await
    .map_err(|_| "The requested folder could not be opened.".to_string())?
}

#[tauri::command]
pub(crate) async fn workspace_watch(
    app: AppHandle,
    state: State<'_, GrokRuntime>,
    watcher_state: State<'_, WorkspaceWatcherRuntime>,
    session_id: String,
    watch_id: String,
) -> Result<(), String> {
    let root = canonical_workspace_root(&session_working_directory(&state, &session_id).await?)?;
    let event_root = root.clone();
    let event_session_id = session_id.clone();
    let event_app = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let paths = workspace_event_paths(&event_root, &event.paths);
        let _ = event_app.emit(
            WORKSPACE_CHANGED_EVENT,
            WorkspaceChangedEvent {
                session_id: event_session_id.clone(),
                paths,
            },
        );
    })
    .map_err(|_| "Live workspace updates could not be started.".to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|_| "The workspace could not be watched for changes.".to_string())?;

    watcher_state
        .watchers
        .lock()
        .map_err(|_| "Live workspace updates are unavailable.".to_string())?
        .insert(session_id, (watch_id, watcher));
    Ok(())
}

#[tauri::command]
pub(crate) fn workspace_unwatch(
    watcher_state: State<'_, WorkspaceWatcherRuntime>,
    session_id: String,
    watch_id: String,
) -> Result<(), String> {
    let mut watchers = watcher_state
        .watchers
        .lock()
        .map_err(|_| "Live workspace updates are unavailable.".to_string())?;
    if watchers
        .get(&session_id)
        .is_some_and(|(active_watch_id, _)| active_watch_id == &watch_id)
    {
        watchers.remove(&session_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        list_workspace_directory, normalize_relative_path, preview_workspace_file,
        resolve_workspace_path, workspace_event_paths, WorkspaceFileKind, WorkspacePreviewKind,
        MAX_TEXT_PREVIEW_BYTES,
    };
    use std::{fs, path::PathBuf};

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "groky-file-manager-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after the epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temporary directory should be created");
        path
    }

    #[test]
    fn rejects_paths_that_escape_the_workspace() {
        assert!(normalize_relative_path("../outside").is_err());
        assert!(normalize_relative_path("folder/../../outside").is_err());
        assert!(normalize_relative_path("/absolute").is_err());
    }

    #[test]
    fn lists_directories_before_files_with_relative_paths() {
        let root = temporary_directory("listing");
        fs::create_dir(root.join("z-folder")).expect("folder should be created");
        fs::write(root.join("a-file.txt"), b"hello").expect("file should be created");
        fs::write(root.join("B-file.txt"), b"world").expect("file should be created");

        let listing = list_workspace_directory(&root, "").expect("directory should be listed");

        assert_eq!(listing.path, "");
        assert_eq!(listing.entries.len(), 3);
        assert_eq!(listing.entries[0].kind, WorkspaceFileKind::Directory);
        assert_eq!(listing.entries[0].path, "z-folder");
        assert_eq!(listing.entries[1].path, "a-file.txt");
        assert_eq!(listing.entries[2].path, "B-file.txt");
        assert!(!listing.truncated);

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn workspace_events_expose_only_deduplicated_relative_paths() {
        let root = temporary_directory("watch-paths");
        let outside = temporary_directory("watch-paths-outside");
        let changed = root.join("src").join("main.ts");

        let paths = workspace_event_paths(
            &root,
            &[changed.clone(), outside.join("secret.txt"), changed],
        );

        assert_eq!(paths, vec!["src/main.ts"]);

        fs::remove_dir_all(root).expect("temporary directory should be removed");
        fs::remove_dir_all(outside).expect("temporary directory should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory("symlink-root");
        let outside = temporary_directory("symlink-outside");
        fs::write(outside.join("secret.txt"), b"secret").expect("file should be created");
        symlink(&outside, root.join("outside-link")).expect("symlink should be created");

        let error = resolve_workspace_path(&root, "outside-link/secret.txt")
            .expect_err("outside symlink should be rejected");
        assert!(error.contains("outside the session working directory"));

        fs::remove_dir_all(root).expect("temporary directory should be removed");
        fs::remove_dir_all(outside).expect("temporary directory should be removed");
    }

    #[test]
    fn previews_utf8_text_and_marks_long_content_as_truncated() {
        let root = temporary_directory("text-preview");
        let content = "a".repeat(MAX_TEXT_PREVIEW_BYTES + 20);
        fs::write(root.join("notes.md"), content).expect("file should be created");

        let preview = preview_workspace_file(&root, "notes.md").expect("file should be previewed");

        assert_eq!(preview.kind, WorkspacePreviewKind::Text);
        assert_eq!(
            preview.content.as_deref().map(str::len),
            Some(MAX_TEXT_PREVIEW_BYTES)
        );
        assert!(preview.truncated);
        assert!(preview.data_url.is_none());

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn previews_supported_images_as_data_urls() {
        let root = temporary_directory("image-preview");
        fs::write(root.join("pixel.png"), [0x89, b'P', b'N', b'G'])
            .expect("file should be created");

        let preview =
            preview_workspace_file(&root, "pixel.png").expect("image should be previewed");

        assert_eq!(preview.kind, WorkspacePreviewKind::Image);
        assert!(preview
            .data_url
            .as_deref()
            .is_some_and(|url| url.starts_with("data:image/png;base64,")));
        assert!(preview.content.is_none());

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn previews_pdf_files_as_data_urls() {
        let root = temporary_directory("pdf-preview");
        fs::write(root.join("guide.pdf"), b"%PDF-1.7\n").expect("file should be created");

        let preview = preview_workspace_file(&root, "guide.pdf").expect("PDF should be previewed");

        assert_eq!(preview.kind, WorkspacePreviewKind::Pdf);
        assert!(preview
            .data_url
            .as_deref()
            .is_some_and(|url| url.starts_with("data:application/pdf;base64,")));

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn previews_unknown_utf8_files_as_text() {
        let root = temporary_directory("unknown-text-preview");
        fs::write(root.join("example.custom"), b"custom format\nvalue = 1\n")
            .expect("file should be created");

        let preview = preview_workspace_file(&root, "example.custom")
            .expect("unknown text file should be previewed");

        assert_eq!(preview.kind, WorkspacePreviewKind::Text);
        assert_eq!(
            preview.content.as_deref(),
            Some("custom format\nvalue = 1\n")
        );

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn previews_typescript_files_as_text_despite_the_ambiguous_mime_type() {
        let root = temporary_directory("typescript-preview");
        fs::write(
            root.join("component.ts"),
            b"export const greeting: string = 'hello';\n",
        )
        .expect("file should be created");

        let preview = preview_workspace_file(&root, "component.ts")
            .expect("TypeScript source should be previewed");

        assert_eq!(preview.kind, WorkspacePreviewKind::Text);
        assert_eq!(
            preview.content.as_deref(),
            Some("export const greeting: string = 'hello';\n")
        );

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn leaves_binary_transport_stream_ts_files_unsupported() {
        let root = temporary_directory("transport-stream-preview");
        fs::write(root.join("recording.ts"), [0x47, 0x00, 0x10, 0x00])
            .expect("file should be created");

        let preview = preview_workspace_file(&root, "recording.ts")
            .expect("transport stream should be inspected");

        assert_eq!(preview.kind, WorkspacePreviewKind::Unsupported);
        assert!(preview.content.is_none());

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn leaves_video_files_unsupported() {
        let root = temporary_directory("video-preview");
        fs::write(root.join("clip.mp4"), b"video data").expect("file should be created");

        let preview = preview_workspace_file(&root, "clip.mp4").expect("video should be inspected");

        assert_eq!(preview.kind, WorkspacePreviewKind::Unsupported);
        assert!(preview.data_url.is_none());

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }

    #[test]
    fn leaves_audio_files_unsupported() {
        let root = temporary_directory("audio-preview");
        fs::write(root.join("recording.mp3"), b"audio data").expect("file should be created");

        let preview =
            preview_workspace_file(&root, "recording.mp3").expect("audio should be inspected");

        assert_eq!(preview.kind, WorkspacePreviewKind::Unsupported);
        assert!(preview.data_url.is_none());

        fs::remove_dir_all(root).expect("temporary directory should be removed");
    }
}
