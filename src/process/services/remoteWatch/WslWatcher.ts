/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
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

export class WslWatcher implements IRemoteWatcher {
  private child: ChildProcess | null = null;
  private _available = true;

  constructor(private readonly distro: string) {}

  get available(): boolean {
    return this._available;
  }

  async start(rootPath: string, handler: (event: RemoteWatchEvent) => void): Promise<void> {
    const watchCommand = `inotifywait -m -r -e modify,create,delete,move --format ${posixEscape(EVENT_FORMAT)} --timefmt %s ${posixEscape(rootPath)}`;
    const prelude = buildRemoteShellPrelude({
      resetHome: true,
      cliCommand: 'inotifywait',
      transportMode: 'simple-stdin',
      workingDir: rootPath,
    });
    const cmd = `${prelude} exec ${watchCommand}`;

    return new Promise<void>((resolve, reject) => {
      const child = spawn('wsl.exe', ['-d', this.distro, '--', 'bash', '-c', cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      let buffered = '';
      let resolved = false;
      const settle = (err?: Error): void => {
        if (resolved) return;
        resolved = true;
        if (err) reject(err);
        else resolve();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf-8');
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const evt = parseLine(line);
          if (evt) handler(evt);
        }
        // First successful chunk → consider start complete.
        settle();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        if (/command not found|inotifywait:.*not found/i.test(text)) {
          this._available = false;
          settle(new Error('inotifywait-not-installed'));
        }
      });

      child.on('error', (err) => {
        this._available = false;
        settle(err);
      });

      child.on('close', (code) => {
        if (code !== 0 && !resolved) {
          this._available = false;
          settle(new Error(`inotifywait exited with code ${code}`));
        }
      });

      // Give inotifywait ~1s to bootstrap; if no data and no error, treat as ready.
      setTimeout(() => settle(), 1_500);
    });
  }

  async stop(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }
}
