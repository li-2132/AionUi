/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RemoteFsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

export interface IRemoteFs {
  list(path: string): Promise<RemoteFsEntry[]>;
  stat(path: string): Promise<RemoteFsEntry>;
  read(path: string, maxBytes?: number): Promise<string>;
  exists(path: string): Promise<boolean>;
  close(): Promise<void>;
}
