/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getCachedRemoteFs } from '@process/services/remoteFs/cache';

export function initRemoteFsBridge(): void {
  ipcBridge.remoteFs.list.provider(async ({ agentId, path }) => {
    const fs = await getCachedRemoteFs(agentId);
    return fs.list(path);
  });

  ipcBridge.remoteFs.stat.provider(async ({ agentId, path }) => {
    const fs = await getCachedRemoteFs(agentId);
    return fs.stat(path);
  });

  ipcBridge.remoteFs.read.provider(async ({ agentId, path, maxBytes }) => {
    const fs = await getCachedRemoteFs(agentId);
    return fs.read(path, maxBytes);
  });

  ipcBridge.remoteFs.exists.provider(async ({ agentId, path }) => {
    const fs = await getCachedRemoteFs(agentId);
    return fs.exists(path);
  });
}
