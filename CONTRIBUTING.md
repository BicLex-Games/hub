# Contributing to BicLex Hub

Thank you for helping improve BicLex Hub.

## Before you start

1. Search existing issues and discussions.
2. Open an issue for large protocol, security, deployment, or UI architecture changes.
3. Keep each pull request focused on one problem.

## Development setup

Client:

```powershell
cd web
npm ci
npm run build
npm run tauri -- dev
```

Server:

```bash
cd server
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Never commit `.env`, room tokens, TURN credentials, updater private keys, logs, chat history, or uploaded files.

## Pull requests

- base changes on `main`;
- use clear commit messages;
- include reproduction steps for bug fixes;
- include screenshots for visible UI changes;
- document new environment variables and open ports;
- explain manual voice, TURN, or screen-sharing tests that cannot be automated;
- preserve backward compatibility for connection codes and signaling messages when practical.

By contributing, you agree that your contribution is licensed under AGPL-3.0.
