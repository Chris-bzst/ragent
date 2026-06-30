FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    tmux \
    python3 \
    build-essential \
    ca-certificates \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Create user workspace directory
RUN mkdir -p /workspace && chmod 755 /workspace

# Set user workspace as HOME
ENV HOME=/workspace
ENV PATH="/workspace/.local/bin:$PATH"

# Create session data directory
RUN mkdir -p /workspace/data/sessions

# Set working directory for backend application
WORKDIR /app/backend

# Copy package files first (for better layer caching)
COPY backend/package*.json ./

# Install production dependencies at build time
RUN npm ci --only=production

# Copy backend source code
COPY backend/ ./

# Copy frontend
COPY frontend/ /app/frontend/

# Copy and prepare entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create non-root user so Claude Code allows bypassPermissions mode.
# /workspace ownership is set at runtime in entrypoint.sh (volumes override build-time chown).
RUN groupadd -r claude && useradd -r -g claude -M -d /workspace -s /bin/bash claude \
    && chown -R claude:claude /app

# Set default shell
ENV SHELL=/bin/bash

# Expose port
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["/entrypoint.sh"]
