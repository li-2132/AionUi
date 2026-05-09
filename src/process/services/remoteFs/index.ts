/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RemoteAgentConfig } from '@process/agent/remote/types';
import { isWslConfig, isSshConfig } from '@process/agent/remote/types';
import { sshClientPool } from '@process/agent/remote/ssh/sshClientPool';
import type { IRemoteFs } from './IRemoteFs';
import { WslFs } from './WslFs';
import { SshSftpFs } from './SshSftpFs';

export type { IRemoteFs, RemoteFsEntry } from './IRemoteFs';

export async function createRemoteFs(config: RemoteAgentConfig): Promise<IRemoteFs> {
  if (config.protocol === 'wsl') {
    if (!isWslConfig(config.connectionConfig)) {
      throw new Error('Missing WSL connection configuration');
    }
    return new WslFs(config.connectionConfig.distro);
  }
  if (config.protocol === 'ssh') {
    if (!isSshConfig(config.connectionConfig)) {
      throw new Error('Missing SSH connection configuration');
    }
    const ssh = config.connectionConfig;
    const client = await sshClientPool.acquire(ssh);
    // Bind release to close() so every getRemoteFs caller automatically returns
    // the pool reference when they are done.
    return new SshSftpFs(client, () => sshClientPool.release(ssh));
  }
  throw new Error(`Remote FS not supported for protocol: ${config.protocol}`);
}
