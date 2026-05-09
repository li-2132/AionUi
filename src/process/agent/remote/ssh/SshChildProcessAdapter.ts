/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ClientChannel, Client as SshClient } from 'ssh2';
import type { Readable, Writable } from 'node:stream';

/**
 * Adapt an ssh2 ClientChannel into the minimal `ChildProcess`-shaped surface
 * that ProcessAcpClient relies on (`stdin` / `stdout` / `stderr` + lifecycle
 * events `exit` / `close` / `error`). Lets the SSH transport reuse the full
 * ACP pipeline without duplicating NDJSON / SDK plumbing.
 */
export class SshChildProcessAdapter extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid = -1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(
    private readonly channel: ClientChannel,
    private readonly client: SshClient
  ) {
    super();
    this.stdin = channel.stdin;
    this.stdout = channel as unknown as Readable;
    this.stderr = channel.stderr;

    let exitEmitted = false;
    const emitExit = (code: number | null, signal: NodeJS.Signals | null = null): void => {
      if (exitEmitted) return;
      exitEmitted = true;
      this.exitCode = code;
      this.signalCode = signal;
      this.emit('exit', code, signal);
    };

    const onClientError = (err: Error): void => {
      this.emit('error', err);
    };

    channel.on('exit', (code: number | null, signalName?: string) => {
      emitExit(code, (signalName as NodeJS.Signals) ?? null);
    });
    channel.on('close', () => {
      emitExit(this.exitCode ?? 0, this.signalCode);
      this.emit('close', this.exitCode ?? 0, this.signalCode);
      // Detach our client-level listener so repeated execs on the same pooled
      // client don't accumulate stale handlers.
      client.removeListener('error', onClientError);
    });
    channel.on('error', (err: Error) => this.emit('error', err));
    client.on('error', onClientError);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return false;
    this.killed = true;
    try {
      this.channel.signal(signal === 'SIGKILL' ? 'KILL' : 'TERM');
    } catch {
      // signal may not be supported by the remote sshd
    }
    try {
      this.channel.close();
    } catch {
      // ignore
    }
    return true;
  }
}
