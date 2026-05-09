/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;

export function isWindowsPath(input: string): boolean {
  return WINDOWS_PATH_RE.test(input);
}

/**
 * Normalize a user-supplied path so WSL can read it.
 *
 * - `C:\foo\bar` → `/mnt/c/foo/bar`
 * - `/home/xuan` → unchanged
 */
export function normalizeWslPath(input: string): string {
  if (!isWindowsPath(input)) return input;
  const drive = input[0].toLowerCase();
  const rest = input.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
  return `/mnt/${drive}/${rest}`;
}
