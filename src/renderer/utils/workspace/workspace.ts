/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace utility functions
 * 工作空间工具函数
 */

/**
 * Pattern to match temporary workspace naming convention: <backend>-temp-<timestamp>
 * Matches any workspace ending with -temp- followed by digits (Unix timestamp)
 * Examples: codex-temp-1234567890, gemini-temp-1234567890, claude-temp-1234567890
 */
const TEMP_WORKSPACE_REGEX = /-temp-\d+$/i;

const splitPathSegments = (targetPath: string): string[] => targetPath.split(/[\\/]+/).filter(Boolean);

/**
 * Check if a workspace path is a temporary workspace
 * 检查工作空间路径是否为临时工作空间
 */
export const isTemporaryWorkspace = (workspacePath: string): boolean => {
  // Extract the last path segment (directory name)
  const parts = splitPathSegments(workspacePath);
  const lastSegment = parts[parts.length - 1] || '';

  // Check if it matches the temporary workspace pattern
  return TEMP_WORKSPACE_REGEX.test(lastSegment);
};

/**
 * Get the display name for a workspace path
 * 获取工作空间的显示名称
 *
 * @param workspacePath - The full workspace path
 * @param t - Optional i18n translation function
 * @returns The display name for the workspace
 */
export const getWorkspaceDisplayName = (workspacePath: string, t?: (key: string) => string): string => {
  // Check for temporary workspace
  if (isTemporaryWorkspace(workspacePath)) {
    // Try to extract timestamp from temp workspace path using the generic pattern
    const parts = splitPathSegments(workspacePath);
    const lastSegment = parts[parts.length - 1] || '';
    const match = lastSegment.match(/-temp-(\d+)$/i);

    if (match) {
      const timestamp = parseInt(match[1], 10);
      const date = new Date(timestamp);
      const dateStr = date.toLocaleDateString();
      const label = t ? t('conversation.workspace.temporarySpace') : 'Temporary Session';
      return `${label} (${dateStr})`;
    }
    return t ? t('conversation.workspace.temporarySpace') : 'Temporary Session';
  }

  // For regular workspace, show the last directory name
  const parts = splitPathSegments(workspacePath);
  return parts[parts.length - 1] || workspacePath;
};

/**
 * Get the last directory name from a path
 * 从路径中获取最后一级目录名
 */
export const getLastDirectoryName = (path: string): string => {
  const parts = splitPathSegments(path);
  return parts[parts.length - 1] || path;
};

/**
 * Reference to either a local working directory or a remote one bound to a
 * specific remote agent (WSL distro / SSH host). Renderer code that wants to
 * pop a directory picker should branch on this discriminator.
 */
export type WorkspaceRef = { type: 'local'; path: string } | { type: 'remote'; agentId: string; path: string };

export const isRemoteWorkspace = (ref: WorkspaceRef): ref is Extract<WorkspaceRef, { type: 'remote' }> =>
  ref.type === 'remote';

/**
 * Format a WorkspaceRef for display in headers / breadcrumbs.
 *
 * @param agentName - Optional pretty name for remote agent (falls back to "Remote").
 */
export const formatWorkspaceLabel = (ref: WorkspaceRef, agentName?: string): string => {
  if (ref.type === 'remote') return `${agentName ?? 'Remote'}: ${ref.path}`;
  return getLastDirectoryName(ref.path);
};
