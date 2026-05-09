/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type RemoteWatchEvent = {
  path: string;
  event: 'modify' | 'create' | 'delete' | 'move';
  timestamp: number;
};

export interface IRemoteWatcher {
  start(rootPath: string, handler: (event: RemoteWatchEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** False after start() if `inotifywait` is missing on the remote side. */
  readonly available: boolean;
}
