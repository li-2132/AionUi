/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RemoteAgentConfig } from '@process/agent/remote/types';
import { isWslConfig, isSshConfig } from '@process/agent/remote/types';
import { sshClientPool } from '@process/agent/remote/ssh/sshClientPool';
import type { IRemoteWatcher } from './IRemoteWatcher';
import { WslWatcher } from './WslWatcher';
import { SshWatcher } from './SshWatcher';

export type { IRemoteWatcher, RemoteWatchEvent } from './IRemoteWatcher';

export async function createRemoteWatcher(config: RemoteAgentConfig): Promise<IRemoteWatcher> {
  if (config.protocol === 'wsl') {
    if (!isWslConfig(config.connectionConfig)) {
      throw new Error('Missing WSL connection configuration');
    }
    return new WslWatcher(config.connectionConfig.distro);
  }
  if (config.protocol === 'ssh') {
    if (!isSshConfig(config.connectionConfig)) {
      throw new Error('Missing SSH connection configuration');
    }
    const ssh = config.connectionConfig;
    const client = await sshClientPool.acquire(ssh);
    return new SshWatcher(client, () => sshClientPool.release(ssh));
  }
  throw new Error(`Remote watch not supported for protocol: ${config.protocol}`);
}
