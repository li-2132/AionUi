/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

const STORE_FILE = 'remote-host-keys.json';

type StoreShape = Record<string, string>;

const keyOf = (host: string, port: number): string => `${host}:${port}`;

const storePath = (): string => path.join(app.getPath('userData'), STORE_FILE);

const load = (): StoreShape => {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoreShape) : {};
  } catch {
    return {};
  }
};

const save = (data: StoreShape): void => {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[hostKeyStore] persist failed:', err);
  }
};

/** Persisted SHA256 fingerprints trusted-on-first-use. */
export const hostKeyStore = {
  has(host: string, port: number, fingerprint: string): boolean {
    return load()[keyOf(host, port)] === fingerprint;
  },
  get(host: string, port: number): string | undefined {
    return load()[keyOf(host, port)];
  },
  accept(host: string, port: number, fingerprint: string): void {
    const data = load();
    data[keyOf(host, port)] = fingerprint;
    save(data);
  },
  remove(host: string, port: number): void {
    const data = load();
    delete data[keyOf(host, port)];
    save(data);
  },
};
