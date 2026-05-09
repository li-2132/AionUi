/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';

const WSL_LIST_TIMEOUT_MS = 8_000;
const VALID_DISTRO_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Discover installed WSL distributions on a Windows host.
 *
 * Returns an empty array on non-Windows platforms or when wsl.exe is absent.
 * The output of `wsl.exe --list --quiet` is UTF-16LE on older WSL versions
 * and UTF-8 on newer ones; we sniff the BOM/null pattern and decode accordingly.
 */
export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return [];

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn('wsl.exe', ['--list', '--quiet'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, WSL_LIST_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => finish([]));
    child.on('close', () => {
      const decoded = decodeWslOutput(Buffer.concat(chunks));
      finish(
        decoded
          .replace(/\u0000/g, '')
          .replace(/\uFEFF/g, '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && VALID_DISTRO_RE.test(line))
      );
    });
  });
}

function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  // BOM 0xFF 0xFE indicates UTF-16LE; otherwise heuristically detect interleaved nulls.
  const hasBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const looksLikeUtf16 = !hasBom && buffer.length >= 4 && buffer[0] !== 0 && buffer[1] === 0;
  return buffer.toString(hasBom || looksLikeUtf16 ? 'utf16le' : 'utf8');
}
