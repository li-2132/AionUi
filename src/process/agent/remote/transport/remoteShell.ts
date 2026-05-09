/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RemoteTransportMode } from '@process/agent/remote/types';

export const posixEscape = (token: string): string => `'${token.replace(/'/g, `'\\''`)}'`;

type RemoteShellPreludeOptions = {
  resetHome: boolean;
  agentId?: string;
  agentName?: string;
  cliCommand: string;
  transportMode: RemoteTransportMode;
  workingDir?: string;
};

const basename = (value: string): string => value.split(/[\\/]/).pop() || value;

const CLAUDE_INTERACTIVE_ENV_CAPTURE =
  'if [ "${AIONUI_REMOTE_CLI_NAME:-}" = "claude" ] && { [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] || [ -z "${ANTHROPIC_BASE_URL:-}" ]; }; then eval "$(AIONUI_REMOTE_CAPTURE=1 bash -ic \'for v in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_MODEL CLAUDE_CODE_MAX_OUTPUT_TOKENS; do val="${!v-}"; [ -n "$val" ] && printf "export %s=%q\\n" "$v" "$val"; done\' 2>/dev/null | sed -n \'/^export \\(ANTHROPIC_\\|CLAUDE_CODE_\\)/p\')"; fi;';

export const buildRemoteShellPrelude = (options: RemoteShellPreludeOptions): string => {
  const resetHome = options.resetHome
    ? 'export HOME="$(getent passwd "$(id -un)" | cut -d: -f6 || printf "%s" "$HOME")";'
    : '';
  const cliName = basename(options.cliCommand);
  const workingDir = options.workingDir
    ? `export AIONUI_REMOTE_WORKING_DIR=${posixEscape(options.workingDir)};`
    : 'unset AIONUI_REMOTE_WORKING_DIR;';

  return [
    resetHome,
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}";',
    options.agentId
      ? `export AIONUI_REMOTE_AGENT_ID=${posixEscape(options.agentId)};`
      : 'unset AIONUI_REMOTE_AGENT_ID;',
    options.agentName
      ? `export AIONUI_REMOTE_AGENT_NAME=${posixEscape(options.agentName)};`
      : 'unset AIONUI_REMOTE_AGENT_NAME;',
    `export AIONUI_REMOTE_CLI_COMMAND=${posixEscape(options.cliCommand)};`,
    `export AIONUI_REMOTE_CLI_NAME=${posixEscape(cliName)};`,
    `export AIONUI_REMOTE_TRANSPORT_MODE=${posixEscape(options.transportMode)};`,
    workingDir,
    'for f in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.bashrc" "$HOME/.aionui-env" "$HOME/.config/aionui/env" "$NVM_DIR/nvm.sh"; do [ -r "$f" ] && . "$f" >/dev/null 2>&1 || true; done;',
    CLAUDE_INTERACTIVE_ENV_CAPTURE,
    'if [ "${AIONUI_REMOTE_CLI_NAME:-}" = "codex" ] && [ -z "${CODEX_HOME:-}" ]; then for d in "$HOME/codex" "$HOME/.config/codex"; do [ -r "$d/config.toml" ] && [ -r "$d/auth.json" ] && export CODEX_HOME="$d" && break; done; fi;',
    'for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.bun/bin" "$NVM_DIR"/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done;',
    'export PATH;',
    'if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then export ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_API_KEY"; fi;',
    'if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then export ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN"; fi;',
  ]
    .filter(Boolean)
    .join(' ');
};
