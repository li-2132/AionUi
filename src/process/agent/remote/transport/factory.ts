/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RemoteAgentConfig } from '@process/agent/remote/types';
import type { IRemoteTransport } from './IRemoteTransport';
import { OpenClawWsTransport } from './OpenClawWsTransport';
import { WslAcpTransport } from './WslAcpTransport';
import { SshAcpTransport } from './SshAcpTransport';
import { SimpleStdinTransport } from './SimpleStdinTransport';

export interface CreateRemoteTransportOptions {
  conversationId: string;
  resumeSessionKey?: string;
}

export function createRemoteTransport(
  config: RemoteAgentConfig,
  options: CreateRemoteTransportOptions
): IRemoteTransport {
  switch (config.protocol) {
    case 'openclaw':
    case 'zeroclaw':
    case 'acp':
      return new OpenClawWsTransport(config);
    case 'wsl':
    case 'ssh': {
      // Default to stream-json (real streaming + tool visualisation, no
      // ACP requirement). `simple-stdin` is the safest fallback for older
      // CLIs; `acp` is opt-in for users on bleeding-edge versions.
      const mode = config.connectionConfig?.transportMode ?? 'stream-json';
      if (mode === 'acp') {
        return config.protocol === 'wsl'
          ? new WslAcpTransport(config, options)
          : new SshAcpTransport(config, options);
      }
      // Both `simple-stdin` and `stream-json` share the SimpleStdinTransport;
      // it switches output parsing internally based on the config.
      return new SimpleStdinTransport(config, options);
    }
    default: {
      const exhaustive: never = config.protocol;
      throw new Error(`Unsupported remote protocol: ${exhaustive as string}`);
    }
  }
}
