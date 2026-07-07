# Ragent

Your remote agent in the digital world. Ragent gives you a full web terminal connected to Claude Code CLI running inside a Docker container — accessible from any browser, on any device.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/4Sz1He?referralCode=_dSteA&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Quick Start

```bash
git clone https://github.com/Chris-bzst/ragent.git
cd ragent
cp .env.example .env
# Edit .env and set your CLAUDE_API_KEY
docker compose up --build
```

Open http://localhost:3001 in your browser.

## How It Works

```
Browser (xterm.js) <--> WebSocket <--> PTY <--> Claude Code CLI
```

The backend creates a pseudo terminal (PTY) connected to Claude Code, and streams the terminal data to your browser via WebSocket. You get the exact same experience as running Claude Code locally.

## Configuration

Set these in your `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_API_KEY` | No | Your Anthropic API key. If not set, run `claude` in the terminal and log in via OAuth |
| `CLAUDE_BASE_URL` | No | Custom API endpoint (proxy, regional) |
| `AUTH_USERNAME` | No | HTTP Basic Auth username |
| `AUTH_PASSWORD` | No | HTTP Basic Auth password |
| `TMUX_SESSION_NAME` | No | Enable shared terminal across browser tabs |

## Per-Repo Agents

One Ragent instance can host a dedicated maintainer agent per repository. Register agents in `/workspace/agents/agents.json`:

```json
{
  "you/frontend": { "name": "front", "persona": "Prefers small, focused diffs." },
  "you/backend":  { "name": "back" }
}
```

Each registered agent gets:

- **Identity** — its name and persona are injected into every run; replies are signed `🤖 Ragent[name]`.
- **Memory** — a persistent notes file (`/workspace/agents/<slug>/notes.md`) injected into every prompt. The agent updates it by ending its output with a ` ```ragent-notes ` block; only the server writes the file.
- **Own-repo autonomy** — each agent owns the full git workflow for its repository: it commits, pushes, and resolves conflicts itself (its worktree's remote is authenticated). Cross-repo discipline is structural — a job's worktree contains only its own repo — plus an explicit prompt contract; server secrets (webhook secret, basic-auth) never enter the agent's env. This model assumes the instance manages **your own private repos with trusted issue authors**; if a repo goes public, move that repo to its own fine-grained per-repo token.
- **Cross-repo requests** — an agent never touches a peer repo. It emits a ` ```ragent-request {"repo", "title", "body"} ` block; the server opens a labeled issue in the target repo, waking that repo's agent, and reports the outcome back on the origin issue. Delegation chains carry `ragent-meta` origin/depth metadata and stop at `RAGENT_MAX_DEPTH` (default 3).

Jobs for the same repo run serially; different repos run in parallel up to `DISPATCH_CONCURRENCY`.

**Configuration**: the GitHub token and webhook secret come from env vars (`DISPATCH_GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`) or, as a fallback, from `/workspace/.ragent/config.json` (`{ "github_token", "webhook_secret" }`) — the file is read lazily, so it can be edited from the instance's own terminal without a restart, and the webhook secret is auto-generated there on first boot. Everything else (labels, webhooks, the registry) can be set up conversationally: the web-terminal Claude session acts as the instance's orchestrator (see `ORCHESTRATOR.md`, seeded into `/workspace`) — tell it to "onboard owner/repo" and it creates the label, the webhook, and the registry entry.

Tuning env: `DISPATCH_ISSUE_LABEL` (default `agent`), `RAGENT_MAX_DEPTH` (default 3), `DISPATCH_CONCURRENCY` (default 1).

## Features

- **Web Terminal** - Full terminal in your browser via xterm.js
- **Mobile Support** - Virtual keyboard toolbar, touch scrolling
- **Shared Sessions** - tmux-backed sessions persist across disconnections
- **Multi-Window** - Create, rename, switch tmux windows from the UI
- **Split Panes** - Horizontal and vertical splits
- **Dev Server Preview** - Auto-detects running dev servers and shows preview in split view
- **Authentication** - Optional HTTP Basic Auth for cloud deployment
- **Persistent Storage** - `/workspace` volume keeps your files across restarts

## Cloud Deployment

### One-Click Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/4Sz1He?referralCode=_dSteA&utm_medium=integration&utm_source=template&utm_campaign=generic)

### Docker

Works on any platform that supports Docker:

```bash
docker run -p 3001:3001 \
  -e CLAUDE_API_KEY=your_key \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=your_password \
  -v ragent_workspace:/workspace \
  ragent
```

For persistent storage, mount a volume to `/workspace`.

## Tech Stack

- **Backend**: Node.js, Express, node-pty, WebSocket
- **Frontend**: xterm.js, vanilla JavaScript
- **Container**: Docker

## License

MIT
