/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { ProcessAcpClient } from '@process/acp/infra/ProcessAcpClient';
import type { ProtocolHandlers, PromptContent } from '@process/acp/types';
import type { RemoteAgentConfig, WslConnectionConfig } from '@process/agent/remote/types';
import { isWslConfig, resolveRemoteCliArgs } from '@process/agent/remote/types';
import { uuid } from '@/common/utils';
import type { CreateRemoteTransportOptions } from './factory';
import type { IRemoteTransport, RemoteTransportHandlers } from './IRemoteTransport';
import { buildRemoteShellPrelude, posixEscape } from './remoteShell';

const VALID_DISTRO_RE = /^[A-Za-z0-9._-]+$/;
const VALID_CLI_TOKEN_RE = /^[A-Za-z0-9._/\-]+$/;

/**
 * WSL transport — spawns a Linux CLI inside a WSL distro and exchanges ACP
 * NDJSON messages over its stdio. Reuses ProcessAcpClient for the full
 * lifecycle (initialize, session, prompt, cancel) and translates ACP session
 * updates into the OpenClaw-style `ChatEvent` / agent stream payloads that
 * RemoteAgentCore already knows how to render.
 */
export class WslAcpTransport implements IRemoteTransport {
  private client: ProcessAcpClient | null = null;
  private handlers: RemoteTransportHandlers = {};
  private connected = false;
  private sessionId: string | undefined;
  private accumulatedText = '';
  private currentRunId: string | null = null;
  private seq = 0;
  private inFlightPrompt = false;
  private readonly conversationId: string;
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
    options: CreateRemoteTransportOptions
  ) {
    this.conversationId = options.conversationId;
  }

  setEventHandler(handlers: RemoteTransportHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('wsl-not-supported');
    }
    if (!isWslConfig(this.config.connectionConfig)) {
      throw new Error('Missing WSL connection configuration');
    }
    const wsl = this.config.connectionConfig;
    this.validate(wsl);

    const handlers: ProtocolHandlers = {
      onSessionUpdate: (notification) => this.handleSessionUpdate(notification),
      onRequestPermission: (request) => this.handleRequestPermission(request),
      onReadTextFile: () => Promise.resolve({ content: '' }),
      onWriteTextFile: () => Promise.resolve({}),
    };

    const spawnFn = async (): Promise<ChildProcess> => this.spawnWsl(wsl);

    this.client = new ProcessAcpClient(spawnFn, { backend: 'wsl-acp', handlers });
    try {
      await this.client.start();

      const session = await this.client.createSession({
        cwd: wsl.workingDir ?? '/',
        mcpServers: [],
      });
      this.sessionId = session.sessionId;
      this.connected = true;
      this.handlers.onConnect?.();
      this.handlers.onSessionKeyUpdate?.(session.sessionId);
    } catch (err) {
      // Roll back partial startup so we never leak the wsl.exe child process.
      const failedClient = this.client;
      this.client = null;
      if (failedClient) {
        await failedClient.close().catch(() => {});
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
    this.connected = false;
    this.handlers.onDisconnect?.('WSL transport stopped');
  }

  async sendMessage(input: { content: string; files?: string[] }): Promise<void> {
    if (this.inFlightPrompt) {
      throw new Error('A previous prompt is still in flight; wait for it to finish');
    }
    const client = this.requireClient();
    if (!this.sessionId) throw new Error('WSL session not initialised');

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
   * session alive so the next message can continue without a re-handshake.
   */
  async cancelCurrent(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      await this.client.cancel(this.sessionId);
    } catch (err) {
      console.warn('[WslAcpTransport] cancel failed:', err);
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

  private spawnWsl(wsl: WslConnectionConfig): ChildProcess {
    const cliBinary = wsl.customCliPath || wsl.cliCommand;
    // Auto-attach `--experimental-acp` (or analogous flag) for known CLIs;
    // custom binaries pass through whatever the user typed in `cliArgs`.
    const finalArgs = resolveRemoteCliArgs(wsl.cliCommand, wsl.cliArgs ?? [], 'acp');
    const tokens = [cliBinary, ...finalArgs].map(posixEscape).join(' ');
    const shellPrelude = buildRemoteShellPrelude({
      resetHome: true,
      agentId: this.config.id,
      agentName: this.config.name,
      cliCommand: cliBinary,
      transportMode: 'acp',
      workingDir: wsl.workingDir,
    });
    const cdCmd = wsl.workingDir ? `cd ${posixEscape(wsl.workingDir)} && ` : '';
    const args = ['-d', wsl.distro, '--', 'bash', '-c', `${shellPrelude} ${cdCmd}exec ${tokens}`];
    return spawn('wsl.exe', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private validate(wsl: WslConnectionConfig): void {
    if (!VALID_DISTRO_RE.test(wsl.distro)) {
      throw new Error(`Invalid WSL distro name: ${wsl.distro}`);
    }
    const cliBinary = wsl.customCliPath || wsl.cliCommand;
    if (!cliBinary || !VALID_CLI_TOKEN_RE.test(cliBinary)) {
      throw new Error('Invalid CLI command');
    }
    for (const arg of wsl.cliArgs ?? []) {
      if (/[\0\n\r]/.test(arg)) {
        throw new Error('CLI arguments must not contain control characters');
      }
    }
  }

  // ─── ACP → OpenClaw event translation ─────────────────────────

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
      runId: this.currentRunId ?? 'wsl',
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
      runId: this.currentRunId ?? 'wsl',
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
      runId: this.currentRunId ?? 'wsl',
      sessionKey: this.sessionId ?? '',
      seq: ++this.seq,
      state: 'error',
      errorMessage,
    });
  }

  private requireClient(): ProcessAcpClient {
    if (!this.client) throw new Error('WSL transport not started');
    return this.client;
  }
}
