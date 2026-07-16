# Groky

Grok Buildをプロジェクト・タスク単位で操作するためのオープンソースデスクトップクライアントです。

> 現在はセットアップ段階です。UIシェルは動きますが、Grok BuildとのACP接続はまだ実装していません。

## 技術構成

- Tauri 2 / Rust
- React 19 / TypeScript / Vite
- pnpm
- Grok Buildの`grok agent stdio`を利用するACPクライアント（次フェーズ）

## 必要なもの

- Node.js 24以上
- pnpm 10
- Rust 1.88以上
- Grok Build CLI（ACP実装時に必要）

## セットアップ

```bash
pnpm install
pnpm tauri dev
```

Web UIだけを確認する場合:

```bash
pnpm dev
```

## 検証

```bash
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
```

## ブランチ運用

当面の既定ブランチは`develop`です。変更は`develop`またはそこから分岐したブランチへ送ってください。

## ライセンス

[Apache License 2.0](LICENSE)
