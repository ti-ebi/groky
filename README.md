# Groky

An unofficial, open-source desktop client for working with Grok Build by project and task.

> Groky is an independent project and is not affiliated with or endorsed by xAI.

Groky runs the official Grok Build CLI locally and connects to `grok agent stdio` over the Agent Client Protocol (ACP). Processes, workspace access, authentication, and ACP traffic stay behind the Tauri host boundary.

## Features

- First-run onboarding for CLI detection and browser sign-in
- Optional workspace selection and switching from the main application screen
- Authentication delegated to the official `grok login` flow
- Local ACP sessions with streamed messages, thoughts, plans, and tool activity
- Session approval modes for ask-first and always-approved work
- Interactive approval prompts for tool permission requests
- Run cancellation, reconnect, disconnect, and sign-out controls
- Signed in-app updates from GitHub Releases
- No application logging of prompts, source code, credentials, session data, or raw ACP traffic

## Tech stack

- Tauri 2 / Rust
- React 19 / TypeScript / Vite
- pnpm
- A typed ACP client powered by Grok Build's `grok agent stdio`

## Requirements

- Node.js 24 or later
- pnpm 10
- Rust 1.88 or later
- Grok Build CLI

## Setup

```bash
pnpm install
pnpm tauri dev
```

On first launch, Groky checks for the CLI and its cached authentication state. If authentication is missing, use **Sign in to Grok** and approve the official xAI device-auth flow in your browser. Groky shows the same short verification code as the browser so you can confirm the request originated in the app. The local CLI detects approval automatically, so there is no code to copy back into Groky. Once authenticated, Groky opens the main application screen. You can start a task without selecting a workspace, or add and switch a local workspace whenever the task needs access to project files. Tasks without a selected workspace get an isolated folder under `Documents/Groky/YYYY-MM-DD/`, which you can open from the connection panel.

Groky also supports an existing `XAI_API_KEY` environment variable when the CLI advertises that authentication method. Groky does not store the key.

To run the web UI only:

```bash
pnpm dev
```

## Verification

```bash
pnpm check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

`pnpm check` runs the frontend typecheck/build, Rust ACP transport tests, and `cargo check`.

## Releasing

Groky checks `https://github.com/ti-ebi/groky/releases/latest/download/latest.json` for signed desktop updates. The public updater key is committed in `src-tauri/tauri.conf.json`; keep its private key outside the repository and back it up securely.

Configure these GitHub Actions secrets before the first release:

- `TAURI_SIGNING_PRIVATE_KEY` with the contents of `~/.tauri/groky.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the updater key is password-protected
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` for macOS code signing
- `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` for macOS notarization

For each release, update the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, merge the release commit into `develop`, then push a matching `vX.Y.Z` tag. The release workflow builds both macOS architectures, Windows NSIS, and Linux AppImage/DEB artifacts, signs updater bundles, generates `latest.json`, and creates a draft GitHub Release. Publish the draft only after testing its installers.

An installation that predates updater support cannot discover the updater-enabled release. Existing users must install that first release manually once; later releases update inside Groky.

## Branching

The default integration branch is `develop`. Submit changes to `develop` or to a branch created from it.

## License

[Apache License 2.0](LICENSE)
