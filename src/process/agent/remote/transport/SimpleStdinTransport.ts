/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Client, ClientChannel } from 'ssh2';
import type {
  RemoteAgentConfig,
  RemoteConnectionConfig,
  RemoteTransportMode,
  SshConnectionConfig,
  WslConnectionConfig,
} from '@process/agent/remote/types';
import { isSshConfig, isWslConfig, resolveRemoteCliArgs } from '@process/agent/remote/types';
import { sshClientPool } from '@process/agent/remote/ssh/sshClientPool';
import { uuid } from '@/common/utils';
import type { CreateRemoteTransportOptions } from './factory';
import type { IRemoteTransport, RemoteTransportHandlers } from './IRemoteTransport';
import { buildRemoteShellPrelude, posixEscape } from './remoteShell';

const VALID_CLI_TOKEN_RE = /^[A-Za-z0-9._/\-]+$/;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60 * 1000;

const readTimeoutMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Stream-JSON / Simple-Stdin transport — re-spawns the remote CLI per message
 * and pipes the prompt over stdin. Two output modes:
 *
 * - `simple-stdin`: stdout is treated as opaque text, accumulated and
 *   re-emitted as ChatEvent deltas. Plain `claude -p` works here.
 * - `stream-json`: stdout is parsed as NDJSON (one event per line), turning
 *   `assistant`/`tool_use`/`tool_result` events into the same ChatEvent /
 *   AgentEvent surface the OpenClaw transport produces. Multi-turn memory is
 *   preserved by capturing the `session_id` from the first `system.init`
 *   event and replaying it via `--resume <id>` on subsequent messages.
 *
 * Both modes work with any Claude Code / Gemini / Codex CLI version — no
 * `--experimental-acp` needed.
 */
export class SimpleStdinTransport implements IRemoteTransport {
  private handlers: RemoteTransportHandlers = {};
  private connected = false;
  private poolAcquired = false;
  private sshClient: Client | null = null;
  private inFlightPrompt = false;
  private currentChild: ChildProcess | null = null;
  private currentChannel: ClientChannel | null = null;
  private accumulatedText = '';
  private currentRunId: string | null = null;
  private seq = 0;
  private remoteSessionId: string | null = null;
  private streamBuffer = '';
  private readonly mode: RemoteTransportMode;
  private readonly idleTimeoutMs: number;
  private readonly hardTimeoutMs: number;

  constructor(
    private readonly config: RemoteAgentConfig,
    options: CreateRemoteTransportOptions
  ) {
    const configuredMode = config.connectionConfig?.transportMode;
    this.mode = configuredMode === 'simple-stdin' ? 'simple-stdin' : 'stream-json';
    const resumeSessionKey = options.resumeSessionKey?.trim();
    this.remoteSessionId = this.mode === 'stream-json' && resumeSessionKey ? resumeSessionKey : null;
    this.idleTimeoutMs = readTimeoutMs('AIONUI_REMOTE_CLI_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS);
    this.hardTimeoutMs = readTimeoutMs('AIONUI_REMOTE_CLI_HARD_TIMEOUT_MS', DEFAULT_HARD_TIMEOUT_MS);
  }

  setEventHandler(handlers: RemoteTransportHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    const cfg = this.config.connectionConfig;
    if (!cfg) throw new Error('Missing remote connection configuration');
    this.validateConfig(cfg);

    if (this.config.protocol === 'ssh' && isSshConfig(cfg)) {
      // Pre-acquire the SSH client up-front so the first message has zero
      // handshake latency and host-key trust is enforced before chatting.
      this.sshClient = await sshClientPool.acquire(cfg);
      this.poolAcquired = true;
    }

    this.connected = true;
    this.handlers.onConnect?.();
    this.handlers.onSessionKeyUpdate?.(this.remoteSessionId ?? uuid());
  }

  async stop(): Promise<void> {
    this.cancelInFlight();
    if (this.poolAcquired && isSshConfig(this.config.connectionConfig)) {
      sshClientPool.release(this.config.connectionConfig);
      this.poolAcquired = false;
    }
    this.sshClient = null;
    this.connected = false;
    this.remoteSessionId = null;
    this.handlers.onDisconnect?.('Simple stdin transport stopped');
  }

  async sendMessage(input: { content: string; files?: string[] }): Promise<void> {
    if (this.inFlightPrompt) {
      throw new Error('A previous prompt is still in flight; wait for it to finish');
    }
    this.inFlightPrompt = true;
    this.accumulatedText = '';
    this.streamBuffer = '';
    this.currentRunId = uuid();

    let processed = input.content;
    if (input.files && input.files.length > 0) {
      const refs = input.files.map((f) => (f.includes(' ') ? `@"${f}"` : `@${f}`)).join(' ');
      processed = `${refs} ${processed}`;
    }

    try {
      if (this.config.protocol === 'wsl') {
        await this.runOverWsl(processed);
      } else if (this.config.protocol === 'ssh') {
        await this.runOverSsh(processed);
      } else {
        throw new Error(`Simple stdin transport does not support protocol: ${this.config.protocol}`);
      }
      // Flush any unterminated NDJSON line that may have been buffered.
      if (this.mode === 'stream-json' && this.streamBuffer) {
        this.dispatchStreamJsonLine(this.streamBuffer);
        this.streamBuffer = '';
      }
      this.emitChatFinal('end_turn');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitChatError(message);
      throw error;
    } finally {
      this.inFlightPrompt = false;
      this.currentChild = null;
      this.currentChannel = null;
    }
  }

  async confirmPermission(): Promise<void> {
    // Stateless mode: claude -p handles its own approvals via flags.
  }

  /**
   * Soft cancel: kill the in-flight CLI process but keep transport state
   * (`connected`, `remoteSessionId`) intact. Next `sendMessage` will spawn
   * fresh and `--resume` the captured Claude Code session.
   */
  async cancelCurrent(): Promise<void> {
    if (!this.inFlightPrompt) return;
    this.cancelInFlight();
    // Surface a clear "aborted" state so the renderer settles the streaming
    // bubble — without this the UI would keep its loading spinner forever.
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'simple-stdin',
      sessionKey: this.sessionKey ?? '',
      seq: ++this.seq,
      state: 'aborted',
    });
    this.inFlightPrompt = false;
    this.currentRunId = null;
    this.accumulatedText = '';
    this.streamBuffer = '';
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get hasActiveSession(): boolean {
    return this.connected;
  }

  get sessionKey(): string | undefined {
    return this.connected ? (this.remoteSessionId ?? 'simple-stdin') : undefined;
  }

  // ─── Argv composition (shared) ──────────────────────────────

  private composeCliArgs(cfg: WslConnectionConfig | SshConnectionConfig): string[] {
    const commandForDefaults = cfg.customCliPath || cfg.cliCommand;
    const args = resolveRemoteCliArgs(commandForDefaults, cfg.cliArgs ?? [], this.mode);
    // For multi-turn continuity in stream-json mode, replay the captured
    // session id so the remote CLI keeps its conversation state.
    if (this.mode === 'stream-json' && this.remoteSessionId) {
      const userHasResume = (cfg.cliArgs ?? []).some((a) => /^--resume(=|$)/.test(a) || /^--continue(=|$)/.test(a));
      if (!userHasResume) {
        args.push('--resume', this.remoteSessionId);
      }
    }
    return args;
  }

  // ─── WSL ────────────────────────────────────────────────────

  private runOverWsl(prompt: string): Promise<void> {
    const wsl = this.config.connectionConfig as WslConnectionConfig;
    const cliBinary = wsl.customCliPath || wsl.cliCommand;
    const finalArgs = this.composeCliArgs(wsl);
    const tokens = [cliBinary, ...finalArgs].map(posixEscape).join(' ');
    // wsl.exe 2.4+ unconditionally injects HOME from the Windows USERPROFILE
    // (e.g. `C:\Users\<u>`), even when the parent process strips it. We force
    // a real Linux home by re-reading /etc/passwd inside the shell — without
    // this, claude looks up `~/.claude.json` at the Windows path and reports
    // "not logged in" despite credentials existing in /home/<u>/.claude.json.
    const shellPrelude = buildRemoteShellPrelude({
      resetHome: true,
      agentId: this.config.id,
      agentName: this.config.name,
      cliCommand: cliBinary,
      transportMode: this.mode,
      workingDir: wsl.workingDir,
    });
    const cdCmd = wsl.workingDir ? `cd ${posixEscape(wsl.workingDir)} && ` : '';
    const innerCmd = `${shellPrelude} ${cdCmd}exec ${tokens}`;
    // Same login-shell rationale as SSH: WSL's `--` invocation runs a
    // non-interactive non-login shell which does not source ~/.bashrc / nvm.
    const args = ['-d', wsl.distro, '--', 'bash', '-c', innerCmd];

    return new Promise((resolve, reject) => {
      const child = spawn('wsl.exe', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.buildWslEnv(),
      });
      this.currentChild = child;
      this.collectAndStreamProcess(child, resolve, reject);
      this.writePrompt(child, prompt, reject);
    });
  }

  /**
   * Strip Windows-style path env vars before launching wsl.exe. Otherwise the
   * Windows parent's `HOME=C:\\Users\\<u>` and `USERPROFILE=C:\\Users\\<u>`
   * leak into the Linux process; bash inherits them verbatim and Claude Code
   * tries to read its credentials from `C:\\Users\\<u>\\.claude.json` instead
   * of the real `/home/<u>/.claude.json`, surfacing as "not logged in".
   */
  private buildWslEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'HOME' || key === 'USERPROFILE') continue;
      env[key] = value;
    }
    return env;
  }

  // ─── SSH ────────────────────────────────────────────────────

  private async runOverSsh(prompt: string): Promise<void> {
    const ssh = this.config.connectionConfig as SshConnectionConfig;
    const command = this.buildSshCommand(ssh);

    try {
      await this.execOverSsh(await this.getSshClient(ssh), command, prompt);
    } catch (error) {
      if (!this.isChannelOpenFailure(error)) {
        throw error;
      }
      sshClientPool.invalidate(ssh);
      this.poolAcquired = false;
      this.sshClient = null;
      await this.execOverSsh(await this.getSshClient(ssh), command, prompt);
    }
  }

  private async getSshClient(ssh: SshConnectionConfig): Promise<Client> {
    if (this.sshClient) return this.sshClient;
    this.sshClient = await sshClientPool.acquire(ssh);
    this.poolAcquired = true;
    return this.sshClient;
  }

  private execOverSsh(client: Client, command: string, prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      client.exec(command, { pty: false }, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        this.currentChannel = channel;
        this.collectAndStreamChannel(channel, resolve, reject);
        this.writePromptToChannel(channel, prompt);
      });
    });
  }

  private isChannelOpenFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /channel open failure|open failed/i.test(message);
  }

  private buildSshCommand(ssh: SshConnectionConfig): string {
    const cliBinary = ssh.customCliPath || ssh.cliCommand;
    const finalArgs = this.composeCliArgs(ssh);
    const tokens = [cliBinary, ...finalArgs].map(posixEscape).join(' ');
    const shellPrelude = buildRemoteShellPrelude({
      resetHome: false,
      agentId: this.config.id,
      agentName: this.config.name,
      cliCommand: cliBinary,
      transportMode: this.mode,
      workingDir: ssh.workingDir,
    });
    const cdCmd = ssh.workingDir ? `cd ${posixEscape(ssh.workingDir)} && ` : '';
    // sshd's non-interactive shell skips user startup files, so run bash with a
    // controlled prelude that quietly loads profile files, nvm, and AionUi's
    // optional env file before exec'ing the CLI.
    return `bash -c ${posixEscape(`${shellPrelude} ${cdCmd}exec ${tokens}`)}`;
  }

  // ─── Output collection ──────────────────────────────────────

  private collectAndStreamProcess(child: ChildProcess, resolve: () => void, reject: (err: Error) => void): void {
    let stderrBuffer = '';
    let settled = false;
    let watchdog: { markActivity: () => void; clear: () => void } | null = null;
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      watchdog?.clear();
      resolve();
    };
    const safeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      watchdog?.clear();
      reject(err);
    };
    watchdog = this.createActivityWatchdog(safeReject);
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        watchdog?.markActivity();
        this.handleStdoutChunk(chunk.toString('utf-8'));
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        watchdog?.markActivity();
        stderrBuffer += chunk.toString('utf-8');
      });
    }
    child.on('error', (err) => safeReject(err));
    child.on('close', (code) => {
      if (code === 0 || (code !== null && this.accumulatedText.length > 0)) {
        safeResolve();
      } else {
        const detail = stderrBuffer.split('\n')[0]?.trim() || `exit code ${code}`;
        safeReject(new Error(detail));
      }
    });
  }

  private collectAndStreamChannel(channel: ClientChannel, resolve: () => void, reject: (err: Error) => void): void {
    let stderrBuffer = '';
    let exitCode: number | null = null;
    let settled = false;
    let watchdog: { markActivity: () => void; clear: () => void } | null = null;
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      watchdog?.clear();
      resolve();
    };
    const safeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      watchdog?.clear();
      reject(err);
    };
    watchdog = this.createActivityWatchdog(safeReject);
    channel.on('data', (chunk: Buffer) => {
      watchdog?.markActivity();
      this.handleStdoutChunk(chunk.toString('utf-8'));
    });
    channel.stderr.on('data', (chunk: Buffer) => {
      watchdog?.markActivity();
      stderrBuffer += chunk.toString('utf-8');
    });
    channel.on('exit', (code) => {
      exitCode = typeof code === 'number' ? code : null;
    });
    channel.on('close', () => {
      if (exitCode === 0 || this.accumulatedText.length > 0) {
        safeResolve();
      } else {
        const detail = stderrBuffer.split('\n')[0]?.trim() || `exit code ${exitCode}`;
        safeReject(new Error(detail));
      }
    });
    channel.on('error', (err: Error) => safeReject(err));
  }

  private createActivityWatchdog(
    onTimeout: (err: Error) => void
  ): { markActivity: () => void; clear: () => void } | null {
    if (this.idleTimeoutMs === 0 && this.hardTimeoutMs === 0) return null;

    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    const pollMs = Math.min(
      5000,
      Math.max(
        250,
        Math.min(this.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS, this.hardTimeoutMs || DEFAULT_HARD_TIMEOUT_MS) / 4
      )
    );
    const timer = setInterval(() => {
      const now = Date.now();
      if (this.hardTimeoutMs > 0 && now - startedAt > this.hardTimeoutMs) {
        this.cancelInFlight();
        onTimeout(new Error(`Remote CLI total timeout after ${Math.round(this.hardTimeoutMs / 1000)}s`));
        return;
      }
      if (this.idleTimeoutMs > 0 && now - lastActivityAt > this.idleTimeoutMs) {
        this.cancelInFlight();
        onTimeout(new Error(`Remote CLI idle timeout after ${Math.round(this.idleTimeoutMs / 1000)}s without output`));
      }
    }, pollMs);
    timer.unref?.();

    return {
      markActivity: () => {
        lastActivityAt = Date.now();
      },
      clear: () => {
        clearInterval(timer);
      },
    };
  }

  private writePrompt(child: ChildProcess, prompt: string, reject: (err: Error) => void): void {
    if (!child.stdin) {
      reject(new Error('Child process has no stdin'));
      return;
    }
    child.stdin.on('error', (err) => reject(err));
    child.stdin.end(prompt, 'utf-8');
  }

  private writePromptToChannel(channel: ClientChannel, prompt: string): void {
    channel.write(prompt, 'utf-8');
    channel.end();
  }

  // ─── stdout dispatch (mode-aware) ───────────────────────────

  private handleStdoutChunk(chunk: string): void {
    if (this.mode === 'simple-stdin') {
      this.appendPlainText(chunk);
      return;
    }
    // stream-json: split on \n, buffer the trailing partial line.
    this.streamBuffer += chunk;
    const lines = this.streamBuffer.split('\n');
    this.streamBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) this.dispatchStreamJsonLine(trimmed);
    }
  }

  private appendPlainText(text: string): void {
    if (!text) return;
    this.accumulatedText += text;
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'simple-stdin',
      sessionKey: this.sessionKey ?? '',
      seq: ++this.seq,
      state: 'delta',
      message: { content: [{ type: 'text', text: this.accumulatedText }] },
    });
  }

  /**
   * Dispatch a single Claude Code stream-json event. Schema (Claude Code v1+):
   *   {type:"system",  subtype:"init", session_id, cwd, tools, model}
   *   {type:"assistant", message:{role:"assistant", content:[{type:"text"|"tool_use", ...}]}}
   *   {type:"user",    message:{role:"user", content:[{type:"tool_result", tool_use_id, content}]}}
   *   {type:"result",  subtype:"success"|"error_max_turns"|..., session_id, duration_ms}
   */
  private dispatchStreamJsonLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not JSON — treat as plain text fallback (some CLIs prefix init banners).
      this.appendPlainText(line + '\n');
      return;
    }

    const type = event.type as string | undefined;
    if (type === 'system') {
      const sessionId = event.session_id as string | undefined;
      if (sessionId) {
        this.remoteSessionId = sessionId;
        this.handlers.onSessionKeyUpdate?.(sessionId);
      }
      return;
    }

    if (type === 'assistant') {
      this.dispatchAssistantMessage(event.message as { content?: unknown[] } | undefined);
      return;
    }

    if (type === 'user') {
      this.dispatchUserMessage(event.message as { content?: unknown[] } | undefined);
      return;
    }

    if (type === 'result') {
      const sessionId = event.session_id as string | undefined;
      if (sessionId) this.remoteSessionId = sessionId;
      const subtype = event.subtype as string | undefined;
      if (subtype && subtype !== 'success') {
        const errMsg = (event.error as string | undefined) ?? `result: ${subtype}`;
        this.emitChatError(errMsg);
      }
      return;
    }
  }

  private dispatchAssistantMessage(message: { content?: unknown[] } | undefined): void {
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
      if (b.type === 'text' && typeof b.text === 'string') {
        this.appendPlainText(b.text);
      } else if (b.type === 'tool_use') {
        this.handlers.onAgentEvent?.({
          stream: 'tool',
          data: {
            phase: 'start',
            name: b.name,
            toolCallId: b.id,
            args: b.input,
            kind: this.inferToolKind(b.name),
          },
          runId: this.currentRunId ?? undefined,
          sessionKey: this.remoteSessionId ?? undefined,
        });
      }
    }
  }

  private dispatchUserMessage(message: { content?: unknown[] } | undefined): void {
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type !== 'tool_result') continue;
      this.handlers.onAgentEvent?.({
        stream: 'tool',
        data: {
          phase: 'result',
          toolCallId: b.tool_use_id,
          isError: !!b.is_error,
          status: b.is_error ? 'failed' : 'completed',
          content: this.normaliseToolResultContent(b.content),
        },
        runId: this.currentRunId ?? undefined,
        sessionKey: this.remoteSessionId ?? undefined,
      });
    }
  }

  private normaliseToolResultContent(raw: unknown): unknown[] | undefined {
    if (typeof raw === 'string') return [{ type: 'content', content: { type: 'text', text: raw } }];
    if (Array.isArray(raw)) return raw;
    return undefined;
  }

  private inferToolKind(name: string | undefined): 'read' | 'edit' | 'execute' {
    if (!name) return 'execute';
    const n = name.toLowerCase();
    if (/read|view|list|search|grep|glob|find|get|fetch/.test(n)) return 'read';
    if (/write|edit|create|delete|patch|update|insert|remove/.test(n)) return 'edit';
    return 'execute';
  }

  // ─── Final / error events ───────────────────────────────────

  private emitChatFinal(stopReason: string): void {
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'simple-stdin',
      sessionKey: this.sessionKey ?? '',
      seq: ++this.seq,
      state: 'final',
      message: this.accumulatedText ? { content: [{ type: 'text', text: this.accumulatedText }] } : undefined,
      stopReason,
    });
    this.accumulatedText = '';
    this.currentRunId = null;
  }

  private emitChatError(errorMessage: string): void {
    this.handlers.onChatEvent?.({
      runId: this.currentRunId ?? 'simple-stdin',
      sessionKey: this.sessionKey ?? '',
      seq: ++this.seq,
      state: 'error',
      errorMessage,
    });
  }

  private cancelInFlight(): void {
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill();
    }
    if (this.currentChannel) {
      try {
        this.currentChannel.close();
      } catch {
        // ignore
      }
    }
    this.currentChild = null;
    this.currentChannel = null;
  }

  private validateConfig(cfg: RemoteConnectionConfig): void {
    if (isWslConfig(cfg)) {
      if (!/^[A-Za-z0-9._-]+$/.test(cfg.distro)) throw new Error(`Invalid WSL distro: ${cfg.distro}`);
      const cliBinary = cfg.customCliPath || cfg.cliCommand;
      if (!cliBinary || !VALID_CLI_TOKEN_RE.test(cliBinary)) throw new Error('Invalid CLI command');
    } else if (isSshConfig(cfg)) {
      if (!cfg.host) throw new Error('SSH host is required');
      const cliBinary = cfg.customCliPath || cfg.cliCommand;
      if (!cliBinary || !VALID_CLI_TOKEN_RE.test(cliBinary)) throw new Error('Invalid CLI command');
    }
  }
}
