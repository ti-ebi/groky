<p align="center">
  <strong>[Groky logo / wordmark placeholder]</strong>
</p>

<h1 align="center">Groky</h1>

<p align="center">
  A local desktop workspace for Grok Build.
</p>

<p align="center">
  Run Grok Build against local projects through a focused, permission-aware desktop interface.
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#what-works-today">Features</a> ·
  <a href="#development">Development</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

> [!WARNING]
> Groky is under active development. The core Grok Build workflow works from source, but the app is not yet presented as a stable release and its behavior may change.

> [!IMPORTANT]
> Groky is an independent, unofficial project and is not affiliated with or endorsed by xAI.

> **Image placeholder — product hero**
>
> Add a full-width screenshot of an active Groky session using a safe sample workspace. Suggested filename: `docs/assets/groky-hero.png`.

## Why Groky

Grok Build is a powerful coding agent. Groky gives it a dedicated desktop workspace built around local projects, visible agent activity, and explicit control over tool execution.

- **Project-focused:** Start in an existing folder or use an isolated standalone working directory.
- **Local integration:** Groky launches the official Grok Build CLI on your machine and communicates with it over the Agent Client Protocol (ACP).
- **Human in the loop:** Review permission requests, choose an approval mode, and cancel an active run at any time.
- **Focused interface:** Follow messages, plans, thoughts, and tool activity without keeping a terminal session open.
- **Native desktop host:** Process and filesystem access stay behind typed Tauri commands in the Rust host.

## What works today

| Area | Current support |
| --- | --- |
| Onboarding | Grok CLI detection, device-code sign-in, and authentication status |
| Working directories | Existing local folders and managed standalone directories under `Documents/Groky/YYYY-MM-DD/` |
| Agent connection | Local ACP sessions powered by `grok agent stdio` |
| Live activity | Streamed messages, thoughts, plans, tool calls, and completion state |
| Permissions | Ask-first and always-approved session modes, plus interactive tool permission requests |
| Model controls | Model and reasoning-effort selection when advertised by Grok Build |
| Session controls | Start, cancel, reconnect, disconnect, reveal the working directory, and sign out |
| Updates | Signed in-app updates backed by GitHub Releases |

> **Image placeholder — setup and permissions**
>
> Add two supporting screenshots: the device-auth onboarding flow and an in-session tool permission request. Suggested filenames: `docs/assets/groky-onboarding.png` and `docs/assets/groky-permission.png`.

## Getting started

### 1. Install Grok Build

Follow the [official Grok Build installation guide](https://docs.x.ai/build/overview). On macOS, Linux, or WSL:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version
```

Groky uses the official CLI as its agent runtime. You can sign in during Groky's onboarding flow, so starting an interactive `grok` session first is optional.

### 2. Run Groky from source

Requirements:

- Node.js 24 or later
- pnpm 10
- Rust 1.88 or later
- Grok Build CLI

```bash
git clone https://github.com/ti-ebi/groky.git
cd groky
pnpm install
pnpm tauri dev
```

### 3. Start a session

On first launch, Groky:

1. Detects the local Grok Build CLI.
2. Checks the CLI's cached authentication state.
3. Starts the official device-code flow when sign-in is required.
4. Lets you choose an existing folder or create a standalone session.
5. Starts Grok Build over ACP when you send the first task.

The verification code shown by Groky should match the code shown in the browser. The CLI detects approval automatically; there is no token or code to paste back into Groky.

Groky can also use an existing `XAI_API_KEY` environment variable when the CLI advertises that authentication method. Groky does not persist the key.

## How it works

```text
React renderer
      │ typed Tauri commands and events
      ▼
Tauri Rust host
      │ JSON-RPC over stdin/stdout
      ▼
Grok Build CLI (`grok agent stdio`)
```

The React renderer does not start processes or access the filesystem directly. The Rust host owns CLI discovery, authentication commands, working-directory access, ACP transport, permission responses, cancellation, and updates.

Grok Build itself handles model and network communication. Prompts and project context are processed according to xAI's Grok Build service and data policies; see the official [Grok Build documentation](https://docs.x.ai/build/overview).

## Privacy and security

- Groky delegates authentication to the official Grok Build CLI.
- Groky does not read or store the resulting browser-auth token.
- Groky does not persist prompts, source code, credentials, session data, or raw ACP traffic in application logs.
- Local processes and filesystem access are initiated through the Tauri Rust host, not the renderer.
- **Always approve** allows Grok Build to execute tool actions without individual permission prompts. Use it only in a working directory you trust.

## Development

Install dependencies and run the desktop application:

```bash
pnpm install
pnpm tauri dev
```

To preview the renderer without starting local processes:

```bash
pnpm dev
```

### Tech stack

- Tauri 2 and Rust
- React 19, TypeScript, and Vite
- pnpm
- A typed ACP client powered by Grok Build's `grok agent stdio`

### Verification

```bash
pnpm check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

`pnpm check` runs the frontend typecheck and build, Rust ACP transport tests, and `cargo check`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

- Branch from `develop`.
- Keep each change focused.
- Run the required checks.
- Open pull requests against `develop`.

## Releasing

<details>
<summary>Maintainer release process</summary>

Groky checks `https://github.com/ti-ebi/groky/releases/latest/download/latest.json` for signed desktop updates. The public updater key is committed in `src-tauri/tauri.conf.json`; keep its private key outside the repository and back it up securely.

Configure these GitHub Actions secrets before the first release:

- `TAURI_SIGNING_PRIVATE_KEY` with the contents of `~/.tauri/groky.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the updater key is password-protected
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` for macOS code signing
- `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` for macOS notarization

For each release, update the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, merge the release commit into `develop`, then push a matching `vX.Y.Z` tag.

The [release workflow](.github/workflows/release.yml) builds both macOS architectures, Windows NSIS, and Linux AppImage/DEB artifacts, signs updater bundles, generates `latest.json`, and creates a draft GitHub Release. Publish the draft only after testing its installers.

An installation that predates updater support cannot discover the updater-enabled release. Existing users must install that first release manually once; later releases can update inside Groky.

</details>

## License

Groky is available under the [Apache License 2.0](LICENSE).
