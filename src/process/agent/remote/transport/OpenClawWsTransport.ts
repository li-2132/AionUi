/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenClawGatewayConnection } from '@process/agent/openclaw/OpenClawGatewayConnection';
import type { ChatEvent, EventFrame, HelloOk } from '@process/agent/openclaw/types';
import { getDatabase } from '@process/services/database';
import type { RemoteAgentConfig } from '@process/agent/remote/types';
import type { OpenClawTransport, RemoteTransportHandlers } from './IRemoteTransport';

/**
 * OpenClaw WebSocket transport — wraps the existing OpenClawGatewayConnection
 * and exposes it as an IRemoteTransport for RemoteAgentCore.
 */
export class OpenClawWsTransport implements OpenClawTransport {
  private connection: OpenClawGatewayConnection | null = null;
  private handlers: RemoteTransportHandlers = {};

  constructor(private readonly config: RemoteAgentConfig) {}

  setEventHandler(handlers: RemoteTransportHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    const { url, authType, authToken } = this.config;
    const connection = new OpenClawGatewayConnection({
      url,
      rejectUnauthorized: !this.config.allowInsecure,
      token: authType === 'bearer' ? authToken : undefined,
      password: authType === 'password' ? authToken : undefined,
      deviceIdentity: this.config.deviceId
        ? {
            deviceId: this.config.deviceId,
            publicKeyPem: this.config.devicePublicKey!,
            privateKeyPem: this.config.devicePrivateKey!,
          }
        : undefined,
      deviceToken: this.config.deviceToken,
      onDeviceTokenIssued: (token) => this.persistDeviceToken(token),
      onEvent: (frame) => this.dispatchFrame(frame),
      onHelloOk: (hello) => this.handlers.onConnect?.(hello),
      onConnectError: (err) => this.handlers.onError?.(err),
      onClose: (code, reason) => this.handlers.onDisconnect?.(`gateway closed (${code}): ${reason}`),
    });
    this.connection = connection;
    connection.start();
  }

  async stop(): Promise<void> {
    this.connection?.stop();
    this.connection = null;
  }

  async sendMessage(input: { content: string; files?: string[] }): Promise<void> {
    const conn = this.requireConnection();
    if (!conn.sessionKey) throw new Error('OpenClaw session not resolved');
    await conn.chatSend({ sessionKey: conn.sessionKey, message: input.content });
  }

  async confirmPermission(_input: { requestId: string; optionId: string }): Promise<void> {
    // OpenClaw permissions are resolved via the in-memory pending map owned by RemoteAgentCore.
    // The transport exposes the request, but resolution happens upstream.
  }

  /**
   * Soft cancel: ask the gateway to abort the current run via `chat.abort` and
   * leave the WebSocket session connected so the next message can continue.
   */
  async cancelCurrent(): Promise<void> {
    const conn = this.connection;
    if (!conn?.sessionKey) return;
    try {
      await conn.chatAbort({ sessionKey: conn.sessionKey });
    } catch (err) {
      console.warn('[OpenClawWsTransport] chatAbort failed:', err);
    }
  }

  get isConnected(): boolean {
    return this.connection?.isConnected ?? false;
  }

  get hasActiveSession(): boolean {
    return !!this.connection?.sessionKey;
  }

  get sessionKey(): string | undefined {
    return this.connection?.sessionKey ?? undefined;
  }

  async sessionsResolve(params: { key: string }): Promise<{ key: string; sessionId: string }> {
    const result = await this.requireConnection().sessionsResolve(params);
    if (this.connection) this.connection.sessionKey = result.key;
    return result;
  }

  async sessionsReset(params: { key: string; reason: 'new' | 'reset' }): Promise<{ key: string; sessionId: string }> {
    const result = await this.requireConnection().sessionsReset(params);
    if (this.connection) this.connection.sessionKey = result.key;
    return result;
  }

  async chatHistory(sessionKey: string, limit?: number): Promise<unknown> {
    return this.requireConnection().chatHistory(sessionKey, limit);
  }

  private dispatchFrame(frame: EventFrame): void {
    switch (frame.event) {
      case 'chat':
      case 'chat.event':
        this.handlers.onChatEvent?.(frame.payload as ChatEvent);
        break;
      case 'agent':
      case 'agent.event':
        this.handlers.onAgentEvent?.(
          frame.payload as { stream: string; data: Record<string, unknown>; runId?: string; sessionKey?: string }
        );
        break;
      case 'exec.approval.request':
        this.handlers.onApprovalRequest?.(
          frame.payload as {
            requestId: string;
            toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown> };
            options?: Array<{ optionId: string; name: string; kind: string }>;
          }
        );
        break;
      case 'shutdown':
        this.handlers.onDisconnect?.('Remote gateway shutdown');
        break;
      case 'health':
      case 'tick':
        break;
      default:
        break;
    }
  }

  private requireConnection(): OpenClawGatewayConnection {
    if (!this.connection) throw new Error('OpenClaw transport not started');
    return this.connection;
  }

  private persistDeviceToken(token: string): void {
    getDatabase()
      .then((db) => {
        db.updateRemoteAgent(this.config.id, { device_token: token });
      })
      .catch((err: unknown) => {
        console.warn('[OpenClawWsTransport] Failed to persist device token:', err);
      });
  }
}

export type { HelloOk };
