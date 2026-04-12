#!/bin/bash

# Runtime configuration for Claude Code
echo "Configuring Claude Code at runtime..."

# Always ensure /workspace/.local/bin is in PATH for all shell sessions
cat >> /etc/bash.bashrc << 'EOF'

# Workspace bin path (always set)
export PATH="/workspace/.local/bin:$PATH"
EOF

# Check if API Key is provided
if [ ! -z "$CLAUDE_API_KEY" ]; then
    echo "API Key provided, setting up authentication..."

    export ANTHROPIC_AUTH_TOKEN="$CLAUDE_API_KEY"
    export ANTHROPIC_API_KEY="$CLAUDE_API_KEY"

    if [ ! -z "$CLAUDE_BASE_URL" ]; then
        echo "Setting custom Claude base URL: $CLAUDE_BASE_URL"
        export ANTHROPIC_BASE_URL="$CLAUDE_BASE_URL"
    fi

    # Write environment variables for all bash sessions
    cat > /etc/profile.d/claude-env.sh << EOF
export ANTHROPIC_AUTH_TOKEN="${CLAUDE_API_KEY}"
export ANTHROPIC_API_KEY="${CLAUDE_API_KEY}"
export ANTHROPIC_BASE_URL="${CLAUDE_BASE_URL}"
export PATH="/workspace/.local/bin:\$PATH"
EOF
    chmod +x /etc/profile.d/claude-env.sh

    # Also add API credentials to /etc/bash.bashrc for non-login shells (used by PTY)
    cat >> /etc/bash.bashrc << EOF

# Claude Code API credentials (auto-configured)
export ANTHROPIC_AUTH_TOKEN="${CLAUDE_API_KEY}"
export ANTHROPIC_API_KEY="${CLAUDE_API_KEY}"
export ANTHROPIC_BASE_URL="${CLAUDE_BASE_URL}"
EOF

    echo "Claude Code ready with API Key authentication"
else
    echo "No API Key provided - run 'claude' in the terminal and log in via OAuth"
fi

# Create user workspace directory
mkdir -p /workspace

# Verify and install Claude Code if needed
echo "Verifying Claude Code installation..."
if [ ! -f "/workspace/.local/bin/claude" ]; then
    echo "Claude CLI not found, installing..."
    curl -fsSL https://claude.ai/install.sh | bash
    if [ -f "/workspace/.local/bin/claude" ]; then
        echo "Claude Code CLI installed successfully"
    else
        echo "Claude Code CLI installation may have failed"
    fi
else
    echo "Claude Code CLI is available"
fi

# Create Claude CLI settings (always enable bypass permissions)
mkdir -p /workspace/.claude
if [ ! -z "$CLAUDE_API_KEY" ]; then
    cat > /workspace/.claude/settings.json << EOF
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${CLAUDE_API_KEY}",
    "ANTHROPIC_BASE_URL": "${CLAUDE_BASE_URL:-https://api.anthropic.com}"
  }
}
EOF
else
    cat > /workspace/.claude/settings.json << 'EOF'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
EOF
fi
chmod 600 /workspace/.claude/settings.json

echo "Configuration completed"

# ==================== Fix ownership ====================
# Entrypoint runs as root to configure system files above;
# now hand everything to the non-root 'claude' user.
chown -R claude:claude /workspace /app

# ==================== tmux Persistent Session ====================
export TMUX_SESSION_NAME

if [ ! -z "$TMUX_SESSION_NAME" ]; then
    echo "Setting up tmux persistent session: $TMUX_SESSION_NAME"

    # Kill any existing dead tmux server (must target claude user's server)
    gosu claude tmux kill-server 2>/dev/null || true

    # Create tmux session as non-root user
    if ! gosu claude tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
        gosu claude tmux new-session -d -s "$TMUX_SESSION_NAME" -c /workspace
        gosu claude tmux set-option -t "$TMUX_SESSION_NAME" history-limit 50000
        gosu claude tmux set-option -t "$TMUX_SESSION_NAME" mouse on
        gosu claude tmux send-keys -t "$TMUX_SESSION_NAME" "source /etc/profile.d/claude-env.sh 2>/dev/null || export PATH=/workspace/.local/bin:\$PATH" Enter
        gosu claude tmux send-keys -t "$TMUX_SESSION_NAME" "clear" Enter
        gosu claude tmux send-keys -t "$TMUX_SESSION_NAME" "cd /workspace" Enter
        echo "tmux session '$TMUX_SESSION_NAME' created"
    fi

    echo "export TMUX_SESSION_NAME=$TMUX_SESSION_NAME" >> /etc/profile.d/claude-env.sh
else
    echo "TMUX_SESSION_NAME not set, running without persistent tmux session"
fi

# ==================== Start Server ====================
echo "Starting Web Claude Code server..."
cd /app/backend

if [ -f "server.js" ]; then
    exec gosu claude node server.js
else
    echo "server.js not found at /app/backend"
    exec gosu claude tail -f /dev/null
fi
