/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import { safeStorage } from 'electron';
import type { SshConnectionConfig } from '@/common/types/detectedAgent';
import { hostKeyStore } from './hostKeyStore';

export interface SshConnectOptions {
  readyTimeout?: number;
}

const DEFAULT_READY_TIMEOUT = 15_000;

const sha256Fingerprint = (raw: Buffer): string =>
  `SHA256:${crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;

const decryptPassphrase = (encrypted: string | undefined): string | undefined => {
  if (!encrypted) return undefined;
  if (!safeStorage.isEncryptionAvailable()) {
    // Fail closed: ciphertext must not be passed verbatim as a passphrase.
    throw new Error('safeStorage encryption unavailable; cannot decrypt SSH key passphrase');
  }
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
};

/**
 * Establish a fresh ssh2 Client with strict host-key verification.
 *
 * Caller MUST have called `hostKeyStore.accept(host, port, fp)` for the
 * expected fingerprint beforehand (typically via `testConnection` →
 * `acceptHostKey`). This function refuses any host key not already trusted.
 */
async function createClient(config: SshConnectionConfig, options: SshConnectOptions): Promise<SshClient> {
  const trusted = hostKeyStore.get(config.host, config.port);
  if (!trusted) {
    throw Object.assign(new Error('ssh-host-key-untrusted'), {
      code: 'HOST_KEY_UNTRUSTED',
      host: config.host,
      port: config.port,
    });
  }

  const privateKey = await fs.readFile(config.privateKeyPath);
  const passphrase = decryptPassphrase(config.encryptedPassphrase);

  const baseConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    privateKey,
    passphrase,
    readyTimeout: options.readyTimeout ?? DEFAULT_READY_TIMEOUT,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostVerifier: ((rawKey: Buffer): boolean => {
      // Synchronous strict verification — only the trusted fingerprint passes.
      return sha256Fingerprint(rawKey) === trusted;
    }) as unknown as ConnectConfig['hostVerifier'],
  };

  return new Promise<SshClient>((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    const onReady = (): void => {
      if (settled) return;
      settled = true;
      client.removeListener('error', onError);
      resolve(client);
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      client.removeListener('ready', onReady);
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
    client.connect(baseConfig);
  });
}

/**
 * Process-wide cache of connected ssh2.Client instances keyed by
 * `host:port:user:keyPath`. Reference-counted so the last consumer triggers
 * the actual end().
 *
 * In-flight `acquire()` calls share the same connection promise to avoid the
 * dual-creation race when two callers ask for the same key concurrently.
 */
type PoolEntry = { client: SshClient; refs: number };
const pool = new Map<string, PoolEntry>();
const inFlight = new Map<string, Promise<SshClient>>();

const poolKey = (config: SshConnectionConfig): string =>
  `${config.host}:${config.port}:${config.username}:${config.privateKeyPath}`;

const teardown = (key: string): void => {
  const entry = pool.get(key);
  if (entry) {
    pool.delete(key);
    try {
      entry.client.end();
    } catch {
      // ignore
    }
  }
  inFlight.delete(key);
};

export const sshClientPool = {
  async acquire(config: SshConnectionConfig, options: SshConnectOptions = {}): Promise<SshClient> {
    const key = poolKey(config);
    const existing = pool.get(key);
    if (existing) {
      existing.refs += 1;
      return existing.client;
    }
    const pending = inFlight.get(key);
    if (pending) {
      const client = await pending;
      const entry = pool.get(key);
      if (entry) entry.refs += 1;
      return client;
    }

    const promise = createClient(config, options).then((client) => {
      pool.set(key, { client, refs: 1 });
      const cleanup = (): void => teardown(key);
      client.once('close', cleanup);
      client.once('end', cleanup);
      // Keep a no-op error listener so post-ready failures don't crash the
      // process; teardown happens via 'close' / 'end' which ssh2 emits after error.
      client.on('error', () => {
        /* logged at the consumer level */
      });
      return client;
    });
    inFlight.set(key, promise);
    try {
      const client = await promise;
      return client;
    } catch (err) {
      teardown(key);
      throw err;
    } finally {
      inFlight.delete(key);
    }
  },

  release(config: SshConnectionConfig): void {
    const key = poolKey(config);
    const entry = pool.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      teardown(key);
    }
  },

  /** Snapshot fingerprint of a host without auth — used by testConnection. */
  async probeFingerprint(config: SshConnectionConfig): Promise<string> {
    let captured = '';
    const client = new SshClient();
    return new Promise<string>((resolve, reject) => {
      const baseConfig: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: 8_000,
        hostVerifier: ((rawKey: Buffer): boolean => {
          captured = sha256Fingerprint(rawKey);
          return false; // reject auth so the connection fails fast
        }) as unknown as ConnectConfig['hostVerifier'],
      };
      client.once('error', () => {
        client.end();
        if (captured) resolve(captured);
        else reject(new Error('Failed to obtain host fingerprint'));
      });
      client.connect(baseConfig);
    });
  },
};

export { sha256Fingerprint };
