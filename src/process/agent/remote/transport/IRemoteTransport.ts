/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatEvent, HelloOk } from '@process/agent/openclaw/types';

/**
 * Unified callback surface that RemoteAgentCore subscribes to. WSL/SSH
 * transports translate ACP session updates into the same shapes consumed by
 * the existing OpenClaw event handlers (ChatEvent / agent stream payload).
 */
export interface RemoteTransportHandlers {
  onConnect?: (hello?: HelloOk) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  onChatEvent?: (event: ChatEvent) => void;
  onAgentEvent?: (event: {
    stream: string;
    data: Record<string, unknown>;
    runId?: string;
    sessionKey?: string;
  }) => void;
  onApprovalRequest?: (request: {
    requestId: string;
    toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: Record<string, unknown> };
    options?: Array<{ optionId: string; name: string; kind: string }>;
  }) => void;
  onSessionKeyUpdate?: (sessionKey: string) => void;
}

export interface IRemoteTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Soft cancel: terminate the in-flight prompt (kill the spawned CLI / abort
   * the ACP request) but keep the transport connected and the remote session
   * alive, so the next `sendMessage` can `--resume` the conversation. Used by
   * the Stop button in the chat UI ("rewind / cancel current generation").
   */
  cancelCurrent(): Promise<void>;
  sendMessage(input: { content: string; files?: string[] }): Promise<void>;
  confirmPermission(input: { requestId: string; optionId: string }): Promise<void>;
  readonly isConnected: boolean;
  readonly hasActiveSession: boolean;
  readonly sessionKey: string | undefined;
  setEventHandler(handlers: RemoteTransportHandlers): void;
}

/** Extension surface for OpenClaw-specific session methods used by RemoteAgentCore. */
export interface OpenClawTransport extends IRemoteTransport {
  sessionsResolve(params: { key: string }): Promise<{ key: string; sessionId: string }>;
  sessionsReset(params: { key: string; reason: 'new' | 'reset' }): Promise<{ key: string; sessionId: string }>;
  chatHistory(sessionKey: string, limit?: number): Promise<unknown>;
}
