/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ProcessAcpClient } from '@process/acp/infra/ProcessAcpClient';
import type { ProtocolHandlers, PromptContent } from '@process/acp/types';
import type { ChildProcess } from 'node:child_process';
import { uuid } from '@/common/utils';
import type { RemoteAgentConfig, SshConnectionConfig } from '@process/agent/remote/types';
import { isSshConfig, resolveRemoteCliArgs } from '@process/agent/remote/types';
import { sshClientPool } from '@process/agent/remote/ssh/sshClientPool';
import { SshChildProcessAdapter } from '@process/agent/remote/ssh/SshChildProcessAdapter';
import type { CreateRemoteTransportOptions } from './factory';
import type { IRemoteTransport, RemoteTransportHandlers } from './IRemoteTransport';
import { buildRemoteShellPrelude, posixEscape } from './remoteShell';

const VALID_CLI_TOKEN_RE = /^[A-Za-z0-9._/\-]+$/;

/**
 * SSH transport — reuses the local ACP pipeline (`ProcessAcpClient` +
 * `NdjsonTransport`) by wrapping an ssh2 exec channel in a ChildProcess-shaped
 * adapter. Auth is private-key only (with optional passphrase decrypted via
 * Electron safeStorage).
 */
export class SshAcpTransport implements IRemoteTransport {
  private client: ProcessAcpClient | null = null;
  private handlers: RemoteTransportHandlers = {};
  private connected = false;
  private sessionId: string | undefined;
  private accumulatedText = '';
  private currentRunId: string | null = null;
  private seq = 0;
  private poolAcquired = false;
  private inFlightPrompt = false;
  private readonly pendingPermissions = new Map<
    string,
    {
      resolve: (response: { outcome: { outcome: 'selected'; optionId: string } }) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly config: RemoteAgentConfig,
    _options: CreateRemoteTransportOptions
  ) {}

  setEventHandler(handlers: RemoteTransportHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (!isSshConfig(this.config.connectionConfig)) {
      throw new Error('Missing SSH connection configuration');
    }
    const ssh = this.config.connectionConfig;
    this.validate(ssh);

    const sshClient = await sshClientPool.acquire(ssh);
    this.poolAcquired = true;

    try {
      const remoteCommand = this.buildRemoteCommand(ssh);

      const handlers: ProtocolHandlers = {
        onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
        onRequestPermission: (request) => this.handleRequestPermission(request),
        onReadTextFile: () => Promise.resolve({ content: '' }),
        onWriteTextFile: () => Promise.resolve({}),
      };

      const spawnFn = async (): Promise<ChildProcess> => {
        return new Promise((resolve, reject) => {
          sshClient.exec(remoteCommand, { pty: false }, (err, channel) => {
            if (err) {
              reject(err);
              return;
            }
            const adapter = new SshChildProcessAdapter(channel, sshClient);
            resolve(adapter as unknown as ChildProcess);
          });
        });
      };

      this.client = new ProcessAcpClient(spawnFn, { backend: 'ssh-acp', handlers });
      await this.client.start();

      const session = await this.client.createSession({
        cwd: ssh.workingDir ?? '/',
        mcpServers: [],
      });
      this.sessionId = session.sessionId;
      this.connected = true;
      this.handlers.onConnect?.();
      this.handlers.onSessionKeyUpdate?.(session.sessionId);
    } catch (err) {
      // Roll back partial startup so we never leak ProcessAcpClient or pool refs.
      if (this.client) {
        await this.client.close().catch(() => {});
        this.client = null;
      }
      if (this.poolAcquired) {
        sshClientPool.release(ssh);
        this.poolAcquired = false;
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport closed'));
    }
    this.pendingPermissions.clear();
    if (this.client) {
      try {
        if (this.sessionId) await this.client.closeSession(this.sessionId);
      } catch {
        // ignore
      }
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
    if (this.poolAcquired && isSshConfig(this.config.connectionConfig)) {
      sshClientPool.release(this.config.connectionConfig);
      this.poolAcquired = false;
    }
    this.connected = false;
    this.handlers.onDisconnect?.('SSH transport stopped');
  }

  async sendMessage(input: { content: string; files?: string[] }): Promise<void> {
    if (this.inFlightPrompt) {
      throw new Error('A previous prompt is still in flight; wait for it to finish');
    }
    const client = this.requireClient();
    if (!this.sessionId) throw new Error('SSH session not initialised');

    this.accumulatedText = '';
    this.currentRunId = uuid();
    this.inFlightPrompt = true;
    const promptContent: PromptContent = [{ type: 'text', text: input.content }];

    try {
      const response = await client.prompt(this.sessionId, promptContent);
      this.emitChatFinal(response.stopReason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitChatError(message);
      throw error;
    } finally {
      this.inFlightPrompt = false;
    }
  }

  async confirmPermission(input: { requestId: string; optionId: string }): Promise<void> {
    const pending = this.pendingPermissions.get(input.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(input.requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId: input.optionId } });
  }

  /**
   * Soft cancel: ask the ACP client to abort the current prompt; keep the
   * SSH session alive so the next message can continue without a re-handshake.
   */
  async cancelCurrent(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      await this.client.cancel(this.sessionId);
    } catch (err) {
      console.warn('[SshAcpTransport] cancel failed:', err);
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get hasActiveSession(): boolean {
    return !!this.sessionId;
  }

  get sessionKey(): string | undefined {
    return this.sessionId;
  }

  // ─── Helpers ──────────────────────────────────────────────

  private validate(ssh: SshConnectionConfig): void {
    if (!ssh.host) throw new Error('SSH host is required');
    if (ssh.port < 1 || ssh.port > 65535) throw new Error(`Invalid SSH port: ${ssh.port}`);
    if (!ssh.username) throw new Error('SSH username is required');
    if (!ssh.privateKeyPath) throw new Error('SSH private key path is required');
    const cliBinary = ssh.customCliPath || ssh.cliCommand;
    if (!cliBinary || !VALID_CLI_TOKEN_RE.test(cliBinary)) {
      throw new Error('Invalid CLI command');
    }
    for (const arg of ssh.cliArgs ?? []) {
      if (/[\0\n\r]/.test(arg)) {
        throw new Error('CLI arguments must not contain control characters');
      }
    }
  }

  private buildRemoteCommand(ssh: SshConnectionConfig): string {
    const cliBinary = ssh.customCliPath || ssh.cliCommand;
    // Known CLIs get their ACP-mode flag attached automatically.
    const finalArgs = resolveRemoteCliArgs(ssh.cliCommand, ssh.cliArgs ?? [], 'acp');
    const tokens = [cliBinary, ...finalArgs].map(posixEscape).join(' ');
    const shellPrelude = buildRemoteShellPrelude({
      resetHome: false,
      agentId: this.config.id,
      agentName: this.config.name,
      cliCommand: cliBinary,
      transportMode: 'acp',
      workingDir: ssh.workingDir,
    });
    const cdCmd = ssh.workingDir ? `cd ${posixEscape(ssh.workingDir)} && ` : '';
    return `bash -c ${posixEscape(`${shellPrelude} ${cdCmd}exec ${tokens}`)}`;
  }

  // ─── ACP → OpenClaw event translation (mirrors WslAcpTransport) ────────

  private handleSessionUpdate(notification: {
    update: { sessionUpdate?: string; content?: unknown; [k: string]: unknown };
  }): void {
    const update = notification.update as {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      [k: string]: unknown;
    };
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.handleAgentMessageChunk(update);
        break;
      case 'agent_thought_chunk':
        this.handleThoughtChunk(update);
        break;
      case 'tool_call':
        this.handleToolCall(notification, 'start');
        break;
      case 'tool_call_update':
        this.handleToolCall(notification, 'update');
        break;
      default:
        break;
    }
  }

  private handleAgentMessageChunk(update: { content?: { type?: string; text?: string } }): void {
    const text = update.content?.type === 'text' ? update.content.text : undefined;
    if (typeof text !== 'string' || text.length === 0) return;
    this.accumulatedText += text;
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'ssh',
      sessionKey: this.sessionId ?? '',
      seq: ++this.seq,
      state: 'delta',
      message: { content: [{ type: 'text', text: this.accumulatedText }] },
    });
  }

  private handleThoughtChunk(update: { content?: { type?: string; text?: string } }): void {
    const text = update.content?.type === 'text' ? update.content.text : undefined;
    if (typeof text !== 'string' || text.length === 0) return;
    this.handlers.onAgentEvent?.({
      stream: 'thought',
      data: { delta: text },
      runId: this.currentRunId ?? undefined,
      sessionKey: this.sessionId,
    });
  }

  private handleToolCall(notification: { update: Record<string, unknown> }, phase: 'start' | 'update'): void {
    const update = notification.update as {
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: string;
      content?: unknown[];
      rawInput?: Record<string, unknown>;
    };
    const isResult = update.status === 'completed' || update.status === 'failed';
    this.handlers.onAgentEvent?.({
      stream: 'tool',
      data: {
        phase: isResult ? 'result' : phase,
        name: update.title,
        toolCallId: update.toolCallId,
        args: update.rawInput,
        isError: update.status === 'failed',
        status: update.status,
        kind: update.kind,
        content: update.content,
      },
      runId: this.currentRunId ?? undefined,
      sessionKey: this.sessionId,
    });
  }

  private async handleRequestPermission(request: {
    id?: string;
    toolCall?: unknown;
    options?: unknown;
  }): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    return new Promise((resolve, reject) => {
      const requestId = (request.id as string | undefined) ?? uuid();
      const timeout = setTimeout(() => {
        const pending = this.pendingPermissions.get(requestId);
        if (pending) {
          this.pendingPermissions.delete(requestId);
          pending.reject(new Error('Permission request timed out'));
        }
      }, 70_000);
      this.pendingPermissions.set(requestId, { resolve, reject, timeout });
      this.handlers.onApprovalRequest?.({
        requestId,
        toolCall: request.toolCall as {
          toolCallId?: string;
          title?: string;
          kind?: string;
          rawInput?: Record<string, unknown>;
        },
        options: request.options as Array<{ optionId: string; name: string; kind: string }>,
      });
    });
  }

  private emitChatFinal(stopReason: string | undefined): void {
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'ssh',
      sessionKey: this.sessionId ?? '',
      seq: ++this.seq,
      state: stopReason === 'cancelled' ? 'aborted' : 'final',
      message: this.accumulatedText ? { content: [{ type: 'text', text: this.accumulatedText }] } : undefined,
      stopReason,
    });
    this.accumulatedText = '';
    this.currentRunId = null;
  }

  private emitChatError(errorMessage: string): void {
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'ssh',
      sessionKey: this.sessionId ?? '',
      seq: ++this.seq,
      state: 'error',
      errorMessage,
    });
  }

  private requireClient(): ProcessAcpClient {
    if (!this.client) throw new Error('SSH transport not started');
    return this.client;
  }
}
