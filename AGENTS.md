# Groky repository guidance

## Scope

- This file applies to the entire repository.
- Put directory-specific guidance in the nearest nested `AGENTS.md`; more specific guidance overrides this file within that subtree.

## Repository map

- `src/` contains the React renderer.
- `src-tauri/` contains the Tauri Rust host.
- Keep process, filesystem, and Grok Build access inside the Tauri host.
- Expose host functionality to the renderer through typed Tauri commands and ACP types.

## Workflow

- Branch from `develop` and open pull requests against `develop`.
- Do not commit directly to `main`.
- Keep each change focused and preserve unrelated working-tree changes.

## Commands

- Install dependencies: `pnpm install`
- Run the web UI: `pnpm dev`
- Run the desktop app: `pnpm tauri dev`
- Run frontend and Rust checks: `pnpm check`
- Check Rust formatting: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`

## Architecture constraints

- Do not access processes or the filesystem directly from the React renderer.
- Run Grok Build only through the Tauri Rust host and its typed ACP boundary.
- Do not persist prompts, source code, credentials, session data, or raw ACP traffic in application logs.

## Verification

- After changing application code, run `pnpm check` and the Rust formatting check.
- When changing ACP transport behavior, add unit tests for framing, request correlation, cancellation, and malformed messages.
- Connect ACP behavior to UI state only after the transport tests pass.
- For documentation-only changes, verify referenced commands and paths; application builds are not required.
- Report which checks were run and identify any checks that could not be run.

## Review guidelines

- Flag direct process or filesystem access from `src/`.
- Flag Grok Build integration that bypasses the typed Tauri ACP boundary.
- Flag logs that may contain prompts, source code, credentials, session data, or raw ACP traffic.
- Require transport-level tests when ACP framing, request lifecycle, or cancellation behavior changes.

## Maintaining this file

- Update this file in the same change when an architecture boundary, canonical command, or required verification workflow changes.
- Add guidance when the same repository-specific mistake or review feedback occurs repeatedly.
- Write one actionable instruction per bullet, using explicit conditions such as "When changing X, run Y" where applicable.
- Put guidance in the closest directory where it applies instead of expanding the root file with local details.
- Remove or revise instructions as soon as they become inaccurate.
- Do not add temporary task context, completed-work history, or general programming advice.
