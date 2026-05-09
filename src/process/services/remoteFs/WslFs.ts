/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as posix from 'node:path/posix';
import type { IRemoteFs, RemoteFsEntry } from './IRemoteFs';

const POSIX_ESCAPE = (token: string): string => `'${token.replace(/'/g, `'\\''`)}'`;

const runWslCommand = (
  distro: string,
  args: string[],
  timeoutMs = 8_000
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', distro, '--', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 124, stdout, stderr: stderr || 'wsl command timed out' });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')));
    child.on('error', (err) => finish({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr }));
  });

export class WslFs implements IRemoteFs {
  constructor(private readonly distro: string) {}

  async list(target: string): Promise<RemoteFsEntry[]> {
    // Format: <type>|<size>|<mtime-epoch>|<name>
    const cmd = `find ${POSIX_ESCAPE(target)} -mindepth 1 -maxdepth 1 -printf '%y|%s|%T@|%f\\n'`;
    const { code, stdout, stderr } = await runWslCommand(this.distro, ['sh', '-c', cmd]);
    if (code !== 0) {
      throw new Error(stderr || `Failed to list ${target}`);
    }
    return stdout
      .split('\n')
      .filter(Boolean)
      .map<RemoteFsEntry | null>((line) => {
        const [type, size, mtime, ...nameParts] = line.split('|');
        if (!type || !nameParts.length) return null;
        const name = nameParts.join('|');
        return {
          name,
          path: posix.join(target, name),
          isDirectory: type === 'd',
          size: Number(size) || 0,
          mtime: Math.floor(Number(mtime) * 1000) || 0,
        };
      })
      .filter((entry): entry is RemoteFsEntry => entry !== null);
  }

  async stat(target: string): Promise<RemoteFsEntry> {
    const cmd = `stat -c '%F|%s|%Y|%n' ${POSIX_ESCAPE(target)}`;
    const { code, stdout, stderr } = await runWslCommand(this.distro, ['sh', '-c', cmd]);
    if (code !== 0) throw new Error(stderr || `Failed to stat ${target}`);
    const [type, size, mtime, name] = stdout.trim().split('|');
    return {
      name: posix.basename(name || target),
      path: target,
      isDirectory: type === 'directory',
      size: Number(size) || 0,
      mtime: Math.floor(Number(mtime) * 1000) || 0,
    };
  }

  async read(target: string, maxBytes = 256 * 1024): Promise<string> {
    const cmd = `head -c ${Math.max(1, Math.floor(maxBytes))} ${POSIX_ESCAPE(target)}`;
    const { code, stdout, stderr } = await runWslCommand(this.distro, ['sh', '-c', cmd]);
    if (code !== 0) throw new Error(stderr || `Failed to read ${target}`);
    return stdout;
  }

  async exists(target: string): Promise<boolean> {
    const cmd = `test -e ${POSIX_ESCAPE(target)} && echo 1 || echo 0`;
    const { code, stdout } = await runWslCommand(this.distro, ['sh', '-c', cmd]);
    if (code !== 0) return false;
    return stdout.trim() === '1';
  }

  async close(): Promise<void> {
    // wsl.exe is spawned per-call; nothing to close.
  }
}
