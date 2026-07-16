# Groky repository guidance

## Workflow

- The default integration branch is `develop`. Do not commit directly to `main`.
- Keep the React renderer free of direct process and filesystem access.
- Run Grok Build only through the Tauri Rust host and its typed ACP boundary.
- Do not persist prompts, source code, credentials, or raw ACP traffic in application logs.

## Commands

- Install: `pnpm install`
- Web development: `pnpm dev`
- Desktop development: `pnpm tauri dev`
- Frontend check: `pnpm build`
- Rust format: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- Rust check: `cargo check --manifest-path src-tauri/Cargo.toml`

## Verification

For setup or UI-only changes, run the frontend build and Rust checks. For ACP work, add unit tests around framing, request correlation, cancellation, and malformed messages before connecting it to UI state.
