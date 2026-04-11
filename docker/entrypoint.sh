#!/bin/bash

# Sets up the environment for the Claude CLI

# Define necessary variables

# Base directory
BASE_DIR="/app"

# Change ownership for necessary directories
chown -R $USER:$USER "$BASE_DIR"

# Execute main command
exec "$BASE_DIR/claude" "$@"
