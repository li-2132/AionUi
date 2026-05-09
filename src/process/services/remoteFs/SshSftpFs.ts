/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client as SshClient, SFTPWrapper } from 'ssh2';
import * as posix from 'node:path/posix';
import type { IRemoteFs, RemoteFsEntry } from './IRemoteFs';

export class SshSftpFs implements IRemoteFs {
  private sftp: SFTPWrapper | null = null;
  private closed = false;

  constructor(
    private readonly client: SshClient,
    private readonly onRelease?: () => void
  ) {}

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp);
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        this.sftp = sftp;
        resolve(sftp);
      });
    });
  }

  async list(target: string): Promise<RemoteFsEntry[]> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(target, (err, list) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          list.map((item) => ({
            name: item.filename,
            path: posix.join(target, item.filename),
            isDirectory: (item.attrs.mode & 0o170000) === 0o040000,
            size: item.attrs.size,
            mtime: item.attrs.mtime * 1000,
          }))
        );
      });
    });
  }

  async stat(target: string): Promise<RemoteFsEntry> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.stat(target, (err, attrs) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          name: posix.basename(target),
          path: target,
          isDirectory: (attrs.mode & 0o170000) === 0o040000,
          size: attrs.size,
          mtime: attrs.mtime * 1000,
        });
      });
    });
  }

  /**
   * Stream up to `maxBytes` from a remote file. Uses `createReadStream` with a
   * highWaterMark so we don't pull the entire file into memory before truncating.
   */
  async read(target: string, maxBytes = 256 * 1024): Promise<string> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const stream = sftp.createReadStream(target, { encoding: 'utf-8', start: 0, end: Math.max(0, maxBytes - 1) });
      let result = '';
      stream.on('data', (chunk: string | Buffer) => {
        result += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        if (result.length >= maxBytes) {
          result = result.slice(0, maxBytes);
          stream.destroy();
          resolve(result);
        }
      });
      stream.on('end', () => resolve(result));
      stream.on('error', (err: Error) => reject(err));
    });
  }

  async exists(target: string): Promise<boolean> {
    try {
      await this.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sftp) {
      const sftp = this.sftp;
      this.sftp = null;
      try {
        sftp.end?.();
      } catch {
        // ignore
      }
    }
    this.onRelease?.();
  }
}
