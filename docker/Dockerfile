FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    tmux \
    python3 \
    build-essential \
    ca-certificates \
    # Browser automation dependencies (optional, for Playwright MCP)
    # These are lightweight system libs only (~50MB), not Chromium itself
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libnss3 \
    libcups2 \
    libxss1 \
    libxrandr2 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libxshmfence1 \
    fonts-liberation \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Create user workspace directory
RUN mkdir -p /workspace && chmod 755 /workspace

# Set user workspace as HOME
ENV HOME=/workspace
ENV PATH="/workspace/.local/bin:$PATH"

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

# Set default shell
ENV SHELL=/bin/bash

# Expose port
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3001/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["/entrypoint.sh"]
