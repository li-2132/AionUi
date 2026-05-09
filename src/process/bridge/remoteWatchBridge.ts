/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import { createRemoteWatcher, type IRemoteWatcher } from '@process/services/remoteWatch';

const watchers = new Map<string, IRemoteWatcher>();

export function initRemoteWatchBridge(): void {
  ipcBridge.remoteWatch.start.provider(async ({ agentId, rootPath }) => {
    if (watchers.has(agentId)) {
      // Already watching — reuse silently.
      return { ok: true, available: watchers.get(agentId)!.available };
    }
    const db = await getDatabase();
    const agent = db.getRemoteAgent(agentId);
    if (!agent) {
      return { ok: false, available: false, error: 'Remote agent not found' };
    }
    try {
      const watcher = await createRemoteWatcher(agent);
      await watcher.start(rootPath, (event) => {
        ipcBridge.remoteWatch.changes.emit({ agentId, ...event });
      });
      if (!watcher.available) {
        await watcher.stop();
        return { ok: false, available: false, error: 'inotifywait-not-installed' };
      }
      watchers.set(agentId, watcher);
      return { ok: true, available: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, available: false, error: message };
    }
  });

  ipcBridge.remoteWatch.stop.provider(async ({ agentId }) => {
    const watcher = watchers.get(agentId);
    if (!watcher) return false;
    await watcher.stop();
    watchers.delete(agentId);
    return true;
  });
}

export async function shutdownRemoteWatchers(): Promise<void> {
  await Promise.all([...watchers.values()].map((w) => w.stop().catch(() => {})));
  watchers.clear();
}
