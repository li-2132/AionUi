/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detection layer types — represents available execution engines in the system.
 *
 * Each `kind` corresponds to a distinct execution engine / communication protocol.
 * Assistants (user-configured presets with skills, prompts, etc.) are a configuration
 * layer that *references* these execution engines — they are NOT detected agents.
 *
 * Uses generic `DetectedAgent<K>`:
 *   - `DetectedAgent`           — any kind, for generic lists
 *   - `DetectedAgent<'acp'>`    — ACP-specific fields directly accessible
 *   - `DetectedAgent<'remote'>` — Remote-specific fields directly accessible
 */

/** Remote agent communication protocol */
export type RemoteAgentProtocol = 'openclaw' | 'zeroclaw' | 'acp' | 'wsl' | 'ssh';

/** Remote agent authentication method */
export type RemoteAgentAuthType = 'bearer' | 'password' | 'none';

/** WSL transport configuration (Windows hosts only) */
export type WslConnectionConfig = {
  distro: string;
  cliCommand: string;
  customCliPath?: string;
  cliArgs?: string[];
  workingDir?: string;
  /**
   * Communication style with the remote CLI. `stream-json` is the default
   * because it provides streaming without ACP. `simple-stdin` is the safest
   * compatibility fallback. `acp` opts into ACP NDJSON and requires the CLI to
   * support `--experimental-acp`.
   */
  transportMode?: RemoteTransportMode;
};

/** SSH transport configuration (private-key auth only) */
export type SshConnectionConfig = {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  /**
   * Plaintext key passphrase — set transiently by the renderer when the user
   * (re)enters one. The main-process bridge encrypts this via Electron
   * safeStorage and replaces it with `encryptedPassphrase` before persistence.
   * NEVER read this field at runtime; only `encryptedPassphrase` is durable.
   */
  passphrase?: string;
  /** Encrypted via electron safeStorage; the only persisted form. */
  encryptedPassphrase?: string;
  cliCommand: string;
  customCliPath?: string;
  cliArgs?: string[];
  workingDir?: string;
  /** SHA256 fingerprint trusted on first use */
  hostFingerprint?: string;
  transportMode?: RemoteTransportMode;
};

/**
 * Remote CLI communication style.
 * - `simple-stdin` (most compatible): spawn `<cli> -p`, write the prompt on
 *   stdin, return stdout as a single message. No streaming visualisation.
 * - `stream-json` (recommended default): same one-shot spawn model but with
 *   `--output-format=stream-json`, so the transport parses NDJSON events and
 *   surfaces streaming text + tool calls. Multi-turn memory is kept by
 *   passing `--resume <session-id>` on subsequent messages.
 * - `acp`: ACP NDJSON protocol over a long-running stdio session. Richest
 *   experience but requires the CLI to support `--experimental-acp`.
 */
export type RemoteTransportMode = 'simple-stdin' | 'stream-json' | 'acp';

export type RemoteConnectionConfig = WslConnectionConfig | SshConnectionConfig;

export const isWslConfig = (c: RemoteConnectionConfig | undefined): c is WslConnectionConfig => !!c && 'distro' in c;

export const isSshConfig = (c: RemoteConnectionConfig | undefined): c is SshConnectionConfig => !!c && 'host' in c;

/**
 * Default flags per transport mode for well-known CLIs. Custom binaries are
 * not in these maps — users supply their own flags via `cliArgs`.
 */
const SIMPLE_STDIN_DEFAULT_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ['-p', '--dangerously-skip-permissions'],
  gemini: ['-p'],
  codex: ['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-'],
};
const STREAM_JSON_DEFAULT_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ['-p', '--output-format=stream-json', '--verbose', '--dangerously-skip-permissions'],
  // Other CLIs do not have a universally supported stream-json flag — users
  // can opt in via `cliArgs` if their tool supports it. Codex still needs
  // `exec -` here because bare `codex` requires a terminal.
  codex: ['exec', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-'],
};
const ACP_DEFAULT_ARGS: Readonly<Record<string, readonly string[]>> = {
  claude: ['--experimental-acp'],
  gemini: ['--experimental-acp'],
  qwen: ['--experimental-acp'],
};

/**
 * Resolve the effective argv list for a remote CLI. Known commands get the
 * appropriate default flags for the chosen transport mode prepended unless the
 * user already supplied a flag that opts into the same mode.
 */
export function resolveRemoteCliArgs(
  cliCommand: string,
  userArgs: readonly string[] = [],
  mode: RemoteTransportMode = 'simple-stdin'
): string[] {
  const table =
    mode === 'acp' ? ACP_DEFAULT_ARGS : mode === 'stream-json' ? STREAM_JSON_DEFAULT_ARGS : SIMPLE_STDIN_DEFAULT_ARGS;
  const commandKey = cliCommand.split(/[\\/]/).pop() ?? cliCommand;
  const defaults = table[commandKey] ?? [];
  const sentinel =
    commandKey === 'codex'
      ? /^(exec|e|review|resume|mcp-server|app-server|exec-server)$/
      : mode === 'acp'
        ? /acp/i
        : mode === 'stream-json'
          ? /stream-json|output-format/i
          : /^-p$|^--print$/;
  const userOpted = userArgs.some((arg) => sentinel.test(arg));
  return userOpted ? [...userArgs] : [...defaults, ...userArgs];
}

/** Execution engine kinds — each uses a different protocol or runtime */
export type DetectedAgentKind = 'gemini' | 'acp' | 'remote' | 'aionrs' | 'openclaw-gateway' | 'nanobot';

/** Kind-specific fields mapping */
type KindFields = {
  gemini: {};

  acp: {
    /** Resolved CLI binary path */
    cliPath?: string;
    /** Extra arguments passed to the ACP CLI */
    acpArgs?: string[];
    /** Whether this agent was contributed by an extension */
    isExtension?: boolean;
    /** Name of the contributing extension */
    extensionName?: string;
    /** Extension-contributed custom agent ID (e.g. 'ext:name:adapterId') */
    customAgentId?: string;
  };

  remote: {
    /** Remote agent config ID (FK to remote_agents table) */
    remoteAgentId: string;
    /** WebSocket endpoint URL */
    url: string;
    /** Remote communication protocol */
    protocol: RemoteAgentProtocol;
    /** Remote authentication method */
    authType: RemoteAgentAuthType;
  };

  aionrs: {
    /** Resolved CLI binary path */
    cliPath?: string;
    /** Binary version string */
    version?: string;
  };

  'openclaw-gateway': {
    /** Resolved CLI binary path */
    cliPath?: string;
    /** Gateway WebSocket URL */
    gatewayUrl?: string;
  };

  nanobot: {
    /** Resolved CLI binary path */
    cliPath?: string;
  };
};

/**
 * Detected execution engine.
 *
 * @typeParam K - Narrows to a specific kind for direct field access.
 *               Defaults to the full union for generic lists.
 */
export type DetectedAgent<K extends DetectedAgentKind = DetectedAgentKind> = {
  id: string;
  name: string;
  kind: K;
  available: boolean;
  /** Backend identifier used for routing and display */
  backend: string;
} & KindFields[K];

// Convenience aliases
export type AcpDetectedAgent = DetectedAgent<'acp'>;
export type GeminiDetectedAgent = DetectedAgent<'gemini'>;
export type RemoteDetectedAgent = DetectedAgent<'remote'>;
export type AionrsDetectedAgent = DetectedAgent<'aionrs'>;
export type NanobotDetectedAgent = DetectedAgent<'nanobot'>;
export type OpenClawDetectedAgent = DetectedAgent<'openclaw-gateway'>;

// Type guard — narrows a generic DetectedAgent to a specific kind
export function isAgentKind<K extends DetectedAgentKind>(agent: DetectedAgent, kind: K): agent is DetectedAgent<K> {
  return agent.kind === kind;
}
