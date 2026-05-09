/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client as SshClient, ClientChannel } from 'ssh2';
import type { IRemoteWatcher, RemoteWatchEvent } from './IRemoteWatcher';
import { buildRemoteShellPrelude, posixEscape } from '@process/agent/remote/transport/remoteShell';

const EVENT_FORMAT = '%w%f|%e|%T';

const parseLine = (line: string): RemoteWatchEvent | null => {
  const segments = line.split('|');
  if (segments.length < 3) return null;
  const [path, eventTypes, ts] = segments;
  const evt = eventTypes.toLowerCase();
  let event: RemoteWatchEvent['event'];
  if (evt.includes('modify')) event = 'modify';
  else if (evt.includes('move')) event = 'move';
  else if (evt.includes('delete')) event = 'delete';
  else if (evt.includes('create')) event = 'create';
  else return null;
  return { path, event, timestamp: Number(ts) * 1000 || Date.now() };
};

export class SshWatcher implements IRemoteWatcher {
  private channel: ClientChannel | null = null;
  private _available = true;
  private released = false;

  constructor(
    private readonly client: SshClient,
    private readonly onRelease?: () => void
  ) {}

  get available(): boolean {
    return this._available;
  }

  async start(rootPath: string, handler: (event: RemoteWatchEvent) => void): Promise<void> {
    const watchCommand = `inotifywait -m -r -e modify,create,delete,move --format ${posixEscape(EVENT_FORMAT)} --timefmt %s ${posixEscape(rootPath)}`;
    const prelude = buildRemoteShellPrelude({
      resetHome: false,
      cliCommand: 'inotifywait',
      transportMode: 'simple-stdin',
      workingDir: rootPath,
    });
    const cmd = `bash -c ${posixEscape(`${prelude} exec ${watchCommand}`)}`;

    return new Promise<void>((resolve, reject) => {
      this.client.exec(cmd, { pty: false }, (err, channel) => {
        if (err) {
          this._available = false;
          reject(err);
          return;
        }
        this.channel = channel;
        let buffered = '';
        let resolved = false;
        const settle = (failure?: Error): void => {
          if (resolved) return;
          resolved = true;
          if (failure) reject(failure);
          else resolve();
        };

        channel.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf-8');
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            const evt = parseLine(line);
            if (evt) handler(evt);
          }
          settle();
        });

        channel.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          if (/command not found|inotifywait:.*not found/i.test(text)) {
            this._available = false;
            settle(new Error('inotifywait-not-installed'));
          }
        });

        channel.on('exit', (code) => {
          if (code !== 0 && !resolved) {
            this._available = false;
            settle(new Error(`inotifywait exited with code ${code}`));
          }
        });

        setTimeout(() => settle(), 1_500);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // ignore
      }
      this.channel = null;
    }
    if (!this.released) {
      this.released = true;
      this.onRelease?.();
    }
  }
}
