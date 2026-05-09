/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database';
import { createRemoteFs, type IRemoteFs } from './index';

interface CacheEntry {
  fs: IRemoteFs;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

const reapExpired = (): void => {
  const now = Date.now();
  for (const [id, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      entry.fs.close().catch(() => {});
      cache.delete(id);
    }
  }
};

export const getCachedRemoteFs = async (agentId: string): Promise<IRemoteFs> => {
  reapExpired();
  const existing = cache.get(agentId);
  if (existing) {
    existing.expiresAt = Date.now() + CACHE_TTL_MS;
    return existing.fs;
  }

  const db = await getDatabase();
  const agent = db.getRemoteAgent(agentId);
  if (!agent) throw new Error(`Remote agent not found: ${agentId}`);
  const fs = await createRemoteFs(agent);
  cache.set(agentId, { fs, expiresAt: Date.now() + CACHE_TTL_MS });
  return fs;
};

export const closeCachedRemoteFs = async (agentId: string): Promise<void> => {
  const entry = cache.get(agentId);
  if (!entry) return;
  cache.delete(agentId);
  await entry.fs.close();
};
