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
