/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { WslConnectionConfig } from '../../src/common/types/detectedAgent';
import { resolveRemoteCliArgs } from '../../src/common/types/detectedAgent';
import type { RemoteAgentConfig } from '../../src/process/agent/remote/types';
import { SimpleStdinTransport } from '../../src/process/agent/remote/transport/SimpleStdinTransport';
import { buildRemoteShellPrelude } from '../../src/process/agent/remote/transport/remoteShell';

describe('resolveRemoteCliArgs', () => {
  it('adds Claude stream-json defaults for the recommended transport mode', () => {
    expect(resolveRemoteCliArgs('claude', [], 'stream-json')).toEqual([
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]);
  });

  it('adds Claude simple stdin defaults for compatibility mode', () => {
    expect(resolveRemoteCliArgs('claude', [], 'simple-stdin')).toEqual(['-p', '--dangerously-skip-permissions']);
  });

  it('runs Codex through non-interactive exec instead of the terminal UI', () => {
    expect(resolveRemoteCliArgs('codex', [], 'simple-stdin')).toEqual([
      'exec',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-',
    ]);
    expect(resolveRemoteCliArgs('codex', [], 'stream-json')).toEqual([
      'exec',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-',
    ]);
  });

  it('preserves explicit Codex subcommands without injecting exec defaults', () => {
    expect(resolveRemoteCliArgs('codex', ['exec', '--json', '-'], 'simple-stdin')).toEqual(['exec', '--json', '-']);
  });

  it('does not duplicate stream-json defaults when the user already opted in', () => {
    expect(resolveRemoteCliArgs('claude', ['--output-format=stream-json', '--model', 'sonnet'], 'stream-json')).toEqual(
      ['--output-format=stream-json', '--model', 'sonnet']
    );
  });

  it('detects known CLI defaults from an absolute executable path', () => {
    expect(resolveRemoteCliArgs('/home/user/.nvm/versions/node/v22.20.0/bin/claude', [], 'stream-json')).toEqual([
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]);
  });

  it('preserves custom command args without injecting Claude-specific flags', () => {
    expect(resolveRemoteCliArgs('/opt/bin/custom-agent', ['--serve'], 'stream-json')).toEqual(['--serve']);
  });

  it('adds ACP defaults only when ACP transport mode is requested', () => {
    expect(resolveRemoteCliArgs('claude', [], 'acp')).toEqual(['--experimental-acp']);
    expect(resolveRemoteCliArgs('claude', [], 'simple-stdin')).toEqual(['-p', '--dangerously-skip-permissions']);
  });
});

describe('buildRemoteShellPrelude', () => {
  it('exports AionUi remote context before loading remote env files', () => {
    const prelude = buildRemoteShellPrelude({
      resetHome: false,
      agentId: 'remote-codex-1',
      agentName: 'Remote Codex',
      cliCommand: '/usr/local/bin/codex',
      transportMode: 'simple-stdin',
      workingDir: '/srv/app',
    });

    expect(prelude).toContain("export AIONUI_REMOTE_AGENT_ID='remote-codex-1';");
    expect(prelude).toContain("export AIONUI_REMOTE_AGENT_NAME='Remote Codex';");
    expect(prelude).toContain("export AIONUI_REMOTE_CLI_COMMAND='/usr/local/bin/codex';");
    expect(prelude).toContain("export AIONUI_REMOTE_CLI_NAME='codex';");
    expect(prelude).toContain("export AIONUI_REMOTE_TRANSPORT_MODE='simple-stdin';");
    expect(prelude).toContain("export AIONUI_REMOTE_WORKING_DIR='/srv/app';");
    expect(prelude).toContain('export CODEX_HOME="$d"');
    expect(prelude).toContain('bash -ic');
    expect(prelude).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(prelude.indexOf('AIONUI_REMOTE_CLI_NAME')).toBeLessThan(prelude.indexOf('$HOME/.aionui-env'));
    expect(prelude.indexOf('$HOME/.aionui-env')).toBeLessThan(prelude.indexOf('export CODEX_HOME="$d"'));
  });
});

describe('SimpleStdinTransport session continuity', () => {
  function makeRemoteConfig(connectionConfig: WslConnectionConfig): RemoteAgentConfig {
    return {
      id: 'remote-1',
      name: 'WSL Claude',
      protocol: 'wsl',
      url: 'wsl://Ubuntu',
      connectionConfig,
      authType: 'none',
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it('reuses the saved Claude session when reopening a stream-json remote conversation', async () => {
    const connectionConfig: WslConnectionConfig = {
      distro: 'Ubuntu',
      cliCommand: 'claude',
      transportMode: 'stream-json',
    };
    const transport = new SimpleStdinTransport(makeRemoteConfig(connectionConfig), {
      conversationId: 'conversation-1',
      resumeSessionKey: 'claude-session-1',
    });
    let reportedSessionKey: string | undefined;
    transport.setEventHandler({
      onSessionKeyUpdate: (sessionKey) => {
        reportedSessionKey = sessionKey;
      },
    });

    await transport.start();
    const cliArgs = (
      transport as unknown as {
        composeCliArgs: (cfg: WslConnectionConfig) => string[];
      }
    ).composeCliArgs(connectionConfig);

    expect(reportedSessionKey).toBe('claude-session-1');
    expect(transport.sessionKey).toBe('claude-session-1');
    expect(cliArgs).toEqual([
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--resume',
      'claude-session-1',
    ]);
  });

  it('reports an idle timeout when a remote CLI stops producing output', () => {
    const previousIdleTimeout = process.env.AIONUI_REMOTE_CLI_IDLE_TIMEOUT_MS;
    const previousHardTimeout = process.env.AIONUI_REMOTE_CLI_HARD_TIMEOUT_MS;
    process.env.AIONUI_REMOTE_CLI_IDLE_TIMEOUT_MS = '1000';
    process.env.AIONUI_REMOTE_CLI_HARD_TIMEOUT_MS = '0';
    vi.useFakeTimers();
    try {
      const transport = new SimpleStdinTransport(
        makeRemoteConfig({
          distro: 'Ubuntu',
          cliCommand: 'claude',
          transportMode: 'stream-json',
        }),
        { conversationId: 'conversation-1' }
      );
      const errors: Error[] = [];
      const watchdog = (
        transport as unknown as {
          createActivityWatchdog: (onTimeout: (err: Error) => void) => { clear: () => void } | null;
        }
      ).createActivityWatchdog((err) => errors.push(err));

      vi.advanceTimersByTime(1250);
      watchdog?.clear();

      expect(errors[0]?.message).toContain('Remote CLI idle timeout');
    } finally {
      if (previousIdleTimeout === undefined) {
        delete process.env.AIONUI_REMOTE_CLI_IDLE_TIMEOUT_MS;
      } else {
        process.env.AIONUI_REMOTE_CLI_IDLE_TIMEOUT_MS = previousIdleTimeout;
      }
      if (previousHardTimeout === undefined) {
        delete process.env.AIONUI_REMOTE_CLI_HARD_TIMEOUT_MS;
      } else {
        process.env.AIONUI_REMOTE_CLI_HARD_TIMEOUT_MS = previousHardTimeout;
      }
      vi.useRealTimers();
    }
  });
});
