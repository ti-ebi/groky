# Groky repository guidance

## Scope

- This file applies to the entire repository.
- Put directory-specific guidance in the nearest nested `AGENTS.md`; more specific guidance overrides this file within that subtree.

## Repository map

- `src/App.tsx` owns renderer-side session orchestration, history, composer state, ACP event projection, and the main layout.
- `src/host/index.ts` owns typed renderer access to Tauri commands and host events; keep raw command and event names there.
- `src/session/projection.ts` owns pure ACP-to-conversation state projection; keep its unit tests in `tests/sessionProjection.test.ts`.
- `src/TerminalPanel.tsx` owns tools-panel tabs; `src/terminal/TerminalSurface.tsx` owns the xterm.js lifecycle.
- `src/FileExplorer.tsx` owns the workspace tree, live refresh, and attach actions; `src/files/FilePreview.tsx` owns preview rendering.
- `src/timing.ts` contains execution-timing helpers; keep their unit tests in `tests/timing.test.ts`.
- `src-tauri/src/lib.rs` owns Tauri command registration, authentication, session history, and application lifecycle.
- `src-tauri/src/models.rs` owns Grok Build model metadata parsing, validation, and selection state.
- `src-tauri/src/acp.rs` owns the Grok Build ACP transport and safe renderer-facing event types.
- `src-tauri/src/file_manager.rs` owns workspace-scoped listing, preview, attachment inspection, folder opening, and watching.
- `src-tauri/src/terminal.rs` owns local PTY creation, I/O, resizing, and cleanup.
- Keep process, filesystem, and Grok Build access inside the Tauri host.
- Expose host functionality to the renderer through typed Tauri commands and ACP types.
- Route renderer command calls and host event subscriptions through `src/host/index.ts` instead of scattering raw Tauri names across components.

## Workflow

- Accept community bug reports, feature requests, and documentation proposals through GitHub Issues.
- Do not ask an external contributor to open a pull request until a maintainer has accepted the issue and agreed on its scope.
- For maintainer work or an invited contribution, branch from `develop` and open the pull request against `develop`.
- Do not commit directly to `main`.
- Promote releases by merging `develop` into `main`; each version update reaching `main` creates a draft GitHub Release.
- Keep each change focused and preserve unrelated working-tree changes.

## Commands

- Install dependencies: `pnpm install`
- Run the web UI: `pnpm dev`
- Run the desktop app: `pnpm tauri dev`
- Run the frontend typecheck and build: `pnpm build`
- Run execution-timing tests: `pnpm test:timing`
- Run all Rust unit tests: `pnpm test:rust`
- Run Rust compilation checks: `pnpm check:rust`
- Run frontend and Rust checks: `pnpm check`
- Check Rust formatting: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`

## Architecture constraints

- Do not access processes or the filesystem directly from the React renderer.
- Run Grok Build only through the Tauri Rust host and its typed ACP boundary.
- Resolve workspace file operations in the Rust host from either an active non-standalone session ID or the registered working directory selected before session creation; require exactly one source, accept normalized relative paths, and reject canonical targets outside its workspace root.
- Keep file preview size limits, MIME handling, attachment inspection, filesystem watching, and system file-manager launching in `src-tauri/src/file_manager.rs`.
- Run interactive shells through the Rust-hosted PTY commands; validate terminal identifiers, dimensions, and input sizes before touching a terminal session.
- Stop PTYs when their terminal tab closes, stop workspace watchers when the Files tab stops targeting a workspace, and stop all host runtimes when the application exits.
- Keep Rust command payloads, emitted event names, and their TypeScript counterparts synchronized, including serde casing and optional fields.
- Do not persist prompts, source code, credentials, session data, or raw ACP traffic in application logs.
- Write all user-facing UI text and host-provided error or status messages in English.

## Verification

- After changing application code, run `pnpm check` and the Rust formatting check.
- When changing ACP transport behavior, add unit tests for framing, request correlation, cancellation, and malformed messages.
- Connect ACP behavior to UI state only after the transport tests pass.
- When changing workspace file access, add Rust tests for path normalization, canonical workspace containment, listing or preview limits, and watcher path projection as applicable.
- When changing terminal host behavior, add Rust tests for identifier, size, input, or lifecycle validation as applicable.
- When changing execution timing or grouping, update `tests/timing.test.ts` and run `pnpm test:timing`.
- For documentation-only changes, verify referenced commands and paths; application builds are not required.
- Report which checks were run and identify any checks that could not be run.

## Review guidelines

- Flag direct process or filesystem access from `src/`.
- Flag Grok Build integration that bypasses the typed Tauri ACP boundary.
- Flag workspace file commands that trust renderer-supplied absolute paths without matching a registered pre-session working directory, or permit traversal or symlink escape outside the resolved workspace root.
- Flag PTYs that survive terminal-tab or application teardown, and flag filesystem watchers that survive Files-tab, session, or application teardown.
- Flag mismatches between Rust command or event payloads and their renderer-side TypeScript types.
- Flag logs that may contain prompts, source code, credentials, session data, or raw ACP traffic.
- Require transport-level tests when ACP framing, request lifecycle, or cancellation behavior changes.

## Maintaining this file

- Update this file in the same change when an architecture boundary, canonical command, or required verification workflow changes.
- Add guidance when the same repository-specific mistake or review feedback occurs repeatedly.
- Write one actionable instruction per bullet, using explicit conditions such as "When changing X, run Y" where applicable.
- Put guidance in the closest directory where it applies instead of expanding the root file with local details.
- Remove or revise instructions as soon as they become inaccurate.
- Do not add temporary task context, completed-work history, or general programming advice.
