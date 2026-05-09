/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { uuid } from '@/common/utils';
import { agentRegistry } from '@process/agent/AgentRegistry';
import { getDatabase } from '@process/services/database';
import { generateIdentity } from '@process/agent/openclaw/deviceIdentity';
import { OpenClawGatewayConnection } from '@process/agent/openclaw/OpenClawGatewayConnection';
import { listWslDistros } from '@process/agent/remote/wsl/wslDetector';
import { sshClientPool } from '@process/agent/remote/ssh/sshClientPool';
import { hostKeyStore } from '@process/agent/remote/ssh/hostKeyStore';
import { isWslConfig, isSshConfig, type RemoteConnectionConfig } from '@/common/types/detectedAgent';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { safeStorage } from 'electron';
import WebSocket from 'ws';

/**
 * Trust-boundary scrubber: any plaintext SSH passphrase coming from the
 * renderer is encrypted via Electron safeStorage and replaced with the
 * durable `encryptedPassphrase` field. The plaintext field is removed before
 * the config is handed to the database layer or the agent registry, so it
 * never reaches durable storage.
 */
function sanitizeConnectionConfigForPersistence(
  config: RemoteConnectionConfig | undefined,
  previous?: RemoteConnectionConfig
): RemoteConnectionConfig | undefined {
  if (!config) return config;
  if (!isSshConfig(config)) return config;
  const next = { ...config } as typeof config & { passphrase?: string };
  if (typeof next.passphrase === 'string' && next.passphrase.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption unavailable; cannot persist SSH passphrase');
    }
    next.encryptedPassphrase = safeStorage.encryptString(next.passphrase).toString('base64');
  } else if (previous && isSshConfig(previous)) {
    // User left the field empty during edit — preserve the existing ciphertext.
    next.encryptedPassphrase = previous.encryptedPassphrase;
  } else {
    next.encryptedPassphrase = undefined;
  }
  delete next.passphrase;
  return next;
}

/**
 * Normalize and validate a WebSocket URL.
 */
function validateWebSocketUrl(url: string): { url: string } | { error: string } {
  try {
    const trimmed = url.trim();
    const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed);
    const raw = hasScheme ? trimmed : `ws://${trimmed}`;
    const parsed = new URL(raw);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return { error: `Unsupported protocol: ${parsed.protocol}` };
    }
    return { url: parsed.toString() };
  } catch {
    return { error: 'Invalid URL' };
  }
}

type TestConnectionInput = {
  protocol: import('@/common/types/detectedAgent').RemoteAgentProtocol;
  url?: string;
  authType?: string;
  authToken?: string;
  allowInsecure?: boolean;
  connectionConfig?: RemoteConnectionConfig;
};

type TestConnectionOutput = {
  success: boolean;
  error?: string;
  status?: 'ok' | 'error' | 'host_key_approval_required';
  fingerprint?: string;
};

async function testOpenClawConnection(input: TestConnectionInput): Promise<TestConnectionOutput> {
  return new Promise<TestConnectionOutput>((resolve) => {
    const validated = validateWebSocketUrl(input.url ?? '');
    if ('error' in validated) {
      resolve({ success: false, status: 'error', error: validated.error });
      return;
    }
    const wsUrl = validated.url;

    let settled = false;
    let ws: WebSocket | undefined;
    const headers: Record<string, string> = {};
    if (input.authType === 'bearer' && input.authToken) {
      headers['Authorization'] = `Bearer ${input.authToken}`;
    }

    const finish = (result: TestConnectionOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws?.close();
      resolve(result);
    };

    const timeout = setTimeout(
      () => finish({ success: false, status: 'error', error: 'Connection timed out (10s)' }),
      10_000
    );

    try {
      ws = new WebSocket(wsUrl, {
        headers,
        handshakeTimeout: 10_000,
        rejectUnauthorized: !input.allowInsecure,
      });
    } catch (error) {
      finish({ success: false, status: 'error', error: error instanceof Error ? error.message : String(error) });
      return;
    }

    ws.on('open', () => finish({ success: true, status: 'ok' }));
    ws.on('error', (err) => finish({ success: false, status: 'error', error: err.message }));
  });
}

async function testWslConnection(input: TestConnectionInput): Promise<TestConnectionOutput> {
  if (process.platform !== 'win32') {
    return { success: false, status: 'error', error: 'WSL is only available on Windows' };
  }
  if (!isWslConfig(input.connectionConfig)) {
    return { success: false, status: 'error', error: 'Missing WSL connection configuration' };
  }
  const wsl = input.connectionConfig;

  const distros = await listWslDistros();
  if (!distros.includes(wsl.distro)) {
    return { success: false, status: 'error', error: `WSL distro not found: ${wsl.distro}` };
  }

  return new Promise<TestConnectionOutput>((resolve) => {
    const child = spawn('wsl.exe', ['-d', wsl.distro, '--', 'true'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (result: TestConnectionOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ success: false, status: 'error', error: 'WSL launch timed out (5s)' });
    }, 5_000);
    child.on('error', (err) => finish({ success: false, status: 'error', error: err.message }));
    child.on('close', (code) =>
      finish(
        code === 0
          ? { success: true, status: 'ok' }
          : { success: false, status: 'error', error: `WSL exited with code ${code}` }
      )
    );
  });
}

async function testSshConnection(input: TestConnectionInput): Promise<TestConnectionOutput> {
  if (!isSshConfig(input.connectionConfig)) {
    return { success: false, status: 'error', error: 'Missing SSH connection configuration' };
  }
  const ssh = input.connectionConfig;

  try {
    await fs.access(ssh.privateKeyPath);
  } catch {
    return { success: false, status: 'error', error: `Private key not found: ${ssh.privateKeyPath}` };
  }

  // Phase 1: confirm host fingerprint is trusted (or surface it for approval).
  let fingerprint: string;
  try {
    fingerprint = await sshClientPool.probeFingerprint(ssh);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, status: 'error', error: message };
  }
  const trusted = hostKeyStore.get(ssh.host, ssh.port);
  if (!trusted || trusted !== fingerprint) {
    return { success: false, status: 'host_key_approval_required', fingerprint };
  }

  // Phase 2: open a real session to verify auth + remote shell.
  try {
    const client = await sshClientPool.acquire(ssh);
    await new Promise<void>((resolve, reject) => {
      client.exec('echo ok', { pty: false }, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        let buffer = '';
        channel.on('data', (chunk: Buffer) => (buffer += chunk.toString('utf-8')));
        channel.on('exit', (code) => {
          if (code === 0 && buffer.trim() === 'ok') resolve();
          else reject(new Error(`Remote shell returned code ${code}`));
        });
      });
    });
    sshClientPool.release(ssh);
    return { success: true, status: 'ok' };
  } catch (err) {
    sshClientPool.release(ssh);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, status: 'error', error: message };
  }
}

export function initRemoteAgentBridge(): void {
  ipcBridge.remoteAgent.list.provider(async () => {
    const db = await getDatabase();
    return db.getRemoteAgents();
  });

  ipcBridge.remoteAgent.get.provider(async ({ id }) => {
    const db = await getDatabase();
    return db.getRemoteAgent(id);
  });

  ipcBridge.remoteAgent.create.provider(async (input) => {
    const db = await getDatabase();
    const now = Date.now();

    const device =
      input.protocol === 'openclaw'
        ? generateIdentity()
        : { deviceId: undefined, publicKeyPem: undefined, privateKeyPem: undefined };

    // Scrub plaintext passphrase BEFORE persisting; the renderer is no longer
    // trusted to hand off encrypted material directly.
    const sanitizedConnection = sanitizeConnectionConfigForPersistence(input.connectionConfig);

    const config = {
      ...input,
      connectionConfig: sanitizedConnection,
      id: uuid(),
      deviceId: device.deviceId,
      devicePublicKey: device.publicKeyPem,
      devicePrivateKey: device.privateKeyPem,
      status: 'unknown' as const,
      createdAt: now,
      updatedAt: now,
    };
    const result = db.createRemoteAgent(config);
    if (!result.success || !result.data) {
      throw new Error(result.error ?? 'Failed to create remote agent');
    }
    agentRegistry.refreshRemoteAgents().catch(() => {});
    return result.data;
  });

  ipcBridge.remoteAgent.update.provider(async ({ id, updates }) => {
    const db = await getDatabase();
    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.protocol !== undefined) dbUpdates.protocol = updates.protocol;
    if (updates.url !== undefined) dbUpdates.url = updates.url;
    if (updates.authType !== undefined) dbUpdates.auth_type = updates.authType;
    if (updates.authToken !== undefined) dbUpdates.auth_token = updates.authToken;
    if (updates.avatar !== undefined) dbUpdates.avatar = updates.avatar;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.allowInsecure !== undefined) dbUpdates.allow_insecure = updates.allowInsecure ? 1 : 0;
    if (updates.connectionConfig !== undefined) {
      // Need the previous record so an empty passphrase preserves (rather than
      // wipes) the existing ciphertext.
      const existing = db.getRemoteAgent(id);
      const sanitized = sanitizeConnectionConfigForPersistence(
        updates.connectionConfig,
        existing?.connectionConfig
      );
      dbUpdates.connection_config = sanitized ? JSON.stringify(sanitized) : null;
    }
    const result = db.updateRemoteAgent(id, dbUpdates);
    if (result.success) agentRegistry.refreshRemoteAgents().catch(() => {});
    return result.success;
  });

  ipcBridge.remoteAgent.delete.provider(async ({ id }) => {
    const db = await getDatabase();
    const result = db.deleteRemoteAgent(id);
    if (result.success) {
      agentRegistry.refreshRemoteAgents().catch(() => {});
    }
    return result.success;
  });

  ipcBridge.remoteAgent.testConnection.provider(async (input) => {
    switch (input.protocol) {
      case 'openclaw':
      case 'zeroclaw':
      case 'acp':
        return testOpenClawConnection(input);
      case 'wsl':
        return testWslConnection(input);
      case 'ssh':
        return testSshConnection(input);
      default:
        return { success: false, status: 'error', error: `Unsupported protocol: ${input.protocol}` };
    }
  });

  ipcBridge.remoteAgent.handshake.provider(async ({ id }) => {
    const db = await getDatabase();
    const agent = db.getRemoteAgent(id);
    if (!agent) {
      return { status: 'error' as const, error: 'Remote agent not found' };
    }

    // Only OpenClaw uses an explicit pairing handshake. WSL/SSH spawn a CLI on
    // demand and authenticate per session.
    if (agent.protocol !== 'openclaw') {
      return { status: 'ok' as const };
    }

    return new Promise<{ status: 'ok' | 'pending_approval' | 'error'; error?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        conn.stop();
        resolve({ status: 'error', error: 'Handshake timed out (15s)' });
      }, 15_000);

      const conn = new OpenClawGatewayConnection({
        url: agent.url,
        rejectUnauthorized: !agent.allowInsecure,
        token: agent.authType === 'bearer' ? agent.authToken : undefined,
        password: agent.authType === 'password' ? agent.authToken : undefined,
        deviceIdentity: agent.deviceId
          ? {
              deviceId: agent.deviceId,
              publicKeyPem: agent.devicePublicKey!,
              privateKeyPem: agent.devicePrivateKey!,
            }
          : undefined,
        deviceToken: agent.deviceToken,
        onDeviceTokenIssued: (token) => {
          db.updateRemoteAgent(id, { device_token: token });
        },
        onHelloOk: () => {
          clearTimeout(timeout);
          conn.stop();
          db.updateRemoteAgent(id, { status: 'connected', last_connected_at: Date.now() });
          resolve({ status: 'ok' });
        },
        onConnectError: (err) => {
          clearTimeout(timeout);
          conn.stop();
          const details = (err as Error & { details?: { recommendedNextStep?: string } }).details;
          const isPairingRequired =
            details?.recommendedNextStep === 'wait_then_retry' || /pairing.required/i.test(err.message);
          if (isPairingRequired) {
            db.updateRemoteAgent(id, { status: 'pending' });
            resolve({ status: 'pending_approval' });
          } else {
            db.updateRemoteAgent(id, { status: 'error' });
            resolve({ status: 'error', error: err.message });
          }
        },
        onClose: (code, reason) => {
          clearTimeout(timeout);
          resolve({ status: 'error', error: `Connection closed (${code}): ${reason}` });
        },
      });

      conn.start();
    });
  });

  ipcBridge.remoteAgent.listWslDistros.provider(async () => {
    return listWslDistros();
  });

  ipcBridge.remoteAgent.acceptHostKey.provider(async ({ id, host, port, fingerprint }) => {
    // Always persist to the global host-key store so subsequent sessions trust it.
    hostKeyStore.accept(host, port, fingerprint);
    if (!id) return true;
    const db = await getDatabase();
    const agent = db.getRemoteAgent(id);
    if (!agent || !isSshConfig(agent.connectionConfig)) return true;
    const updated: RemoteConnectionConfig = { ...agent.connectionConfig, hostFingerprint: fingerprint };
    const result = db.updateRemoteAgent(id, { connection_config: JSON.stringify(updated) });
    return result.success;
  });
}
