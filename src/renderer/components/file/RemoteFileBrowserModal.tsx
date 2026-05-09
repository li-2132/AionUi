/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Breadcrumb, Button, Input, List, Message, Spin, Typography } from '@arco-design/web-react';
import { Folder, FileText, Refresh, Up } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import AionModal from '@/renderer/components/base/AionModal';
import type { RemoteAgentConfig } from '@process/agent/remote/types';

interface RemoteFsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

export type BrowseMode = 'directory' | 'file' | 'any';

interface RemoteFileBrowserModalProps {
  visible: boolean;
  agentId: string;
  agent: RemoteAgentConfig;
  mode: BrowseMode;
  initialPath?: string;
  modalZIndex?: number;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

const defaultRoot = (agent: RemoteAgentConfig): string => {
  if (agent.protocol === 'wsl') return '/home';
  return '/';
};

const splitPath = (p: string): string[] => p.split('/').filter(Boolean);

const buildPath = (segments: string[]): string => '/' + segments.join('/');

const parentOf = (p: string): string => {
  const segments = splitPath(p);
  segments.pop();
  return segments.length === 0 ? '/' : buildPath(segments);
};

const RemoteFileBrowserModal: React.FC<RemoteFileBrowserModalProps> = ({
  visible,
  agentId,
  agent,
  mode,
  initialPath,
  modalZIndex,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState<string>(initialPath || defaultRoot(agent));
  const [entries, setEntries] = useState<RemoteFsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [manualPath, setManualPath] = useState<string>(initialPath || defaultRoot(agent));

  const breadcrumbs = useMemo(() => splitPath(currentPath), [currentPath]);

  const loadEntries = useCallback(
    async (path: string, signal: AbortSignal) => {
      setLoading(true);
      try {
        const list = await ipcBridge.remoteFs.list.invoke({ agentId, path });
        if (signal.aborted) return;
        list.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(list);
        setSelectedPath('');
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        Message.error(t('conversation.remoteFileBrowser.error') + (message ? `: ${message}` : ''));
        setEntries([]);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [agentId, t]
  );

  useEffect(() => {
    if (!visible) return;
    const initial = initialPath || defaultRoot(agent);
    setCurrentPath(initial);
    setManualPath(initial);
    const controller = new AbortController();
    void loadEntries(initial, controller.signal);
    return () => controller.abort();
  }, [visible, agent, initialPath, loadEntries]);

  useEffect(() => {
    setManualPath(currentPath);
    if (!visible) return;
    const controller = new AbortController();
    void loadEntries(currentPath, controller.signal);
    return () => controller.abort();
  }, [currentPath, visible, loadEntries]);

  const handleEntryClick = (entry: RemoteFsEntry): void => {
    setSelectedPath(entry.path);
  };

  const handleEntryDoubleClick = (entry: RemoteFsEntry): void => {
    if (entry.isDirectory) {
      setCurrentPath(entry.path);
    } else if (mode !== 'directory') {
      onConfirm(entry.path);
    }
  };

  const handleBreadcrumb = (idx: number): void => {
    setCurrentPath(buildPath(breadcrumbs.slice(0, idx + 1)));
  };

  const handleParent = (): void => {
    if (currentPath !== '/') setCurrentPath(parentOf(currentPath));
  };

  const handleConfirm = (): void => {
    if (mode === 'directory') {
      onConfirm(selectedPath || manualPath || currentPath);
      return;
    }
    // Prefer an entry selection; fall back to a manually typed file path.
    const target = selectedPath || (manualPath !== currentPath ? manualPath : '');
    if (target) onConfirm(target);
  };

  const handleManualPathSubmit = (): void => {
    if (manualPath && manualPath !== currentPath) {
      setCurrentPath(manualPath);
    }
  };

  return (
    <AionModal
      visible={visible}
      onCancel={onCancel}
      header={{
        title: t('conversation.remoteFileBrowser.title', { name: agent.name }),
        showClose: true,
      }}
      style={{ maxWidth: '92vw', width: 720, borderRadius: 16 }}
      wrapStyle={modalZIndex ? { zIndex: modalZIndex } : undefined}
      maskStyle={modalZIndex ? { zIndex: modalZIndex - 1 } : undefined}
      contentStyle={{ background: 'var(--dialog-fill-0)', borderRadius: 16, padding: 16, overflow: 'hidden' }}
      okText={t('conversation.remoteFileBrowser.confirm')}
      cancelText={t('conversation.remoteFileBrowser.cancel')}
      onOk={handleConfirm}
      okButtonProps={{ disabled: mode !== 'directory' && !selectedPath && manualPath === currentPath }}
    >
      <div className='flex flex-col gap-12px h-440px'>
        <div className='flex items-center gap-8px rounded-8px bg-[var(--color-fill-1)] px-12px py-8px'>
          <Button
            size='mini'
            type='text'
            icon={<Up theme='outline' size='14' />}
            onClick={handleParent}
            disabled={currentPath === '/'}
          />
          <Breadcrumb className='flex-1'>
            <Breadcrumb.Item className='cursor-pointer' onClick={() => setCurrentPath('/')}>
              /
            </Breadcrumb.Item>
            {breadcrumbs.map((seg, i) => (
              <Breadcrumb.Item key={i} className='cursor-pointer' onClick={() => handleBreadcrumb(i)}>
                {seg}
              </Breadcrumb.Item>
            ))}
          </Breadcrumb>
          <Button
            size='mini'
            type='text'
            icon={<Refresh theme='outline' size='14' />}
            onClick={() => {
              const ctrl = new AbortController();
              void loadEntries(currentPath, ctrl.signal);
            }}
          />
        </div>

        <div className='flex-1 overflow-auto rounded-8px border border-solid border-[var(--color-border-2)] bg-[var(--color-bg-2)]'>
          {loading ? (
            <div className='flex h-full items-center justify-center'>
              <Spin size={20} />
            </div>
          ) : (
            <List
              dataSource={entries}
              noDataElement={
                <div className='py-40px text-center text-12px text-t-tertiary'>
                  {t('conversation.remoteFileBrowser.empty')}
                </div>
              }
              render={(item) => (
                <List.Item
                  key={item.path}
                  className={`!cursor-pointer hover:bg-[var(--color-fill-2)] ${
                    selectedPath === item.path ? '!bg-[rgba(var(--primary-6),0.1)]' : ''
                  }`}
                  onClick={() => handleEntryClick(item)}
                  onDoubleClick={() => handleEntryDoubleClick(item)}
                >
                  <div className='flex items-center gap-10px py-2px'>
                    {item.isDirectory ? (
                      <Folder theme='outline' size='16' className='shrink-0 text-[rgb(var(--primary-6))]' />
                    ) : (
                      <FileText theme='outline' size='16' className='shrink-0 text-t-secondary' />
                    )}
                    <Typography.Text ellipsis className='flex-1 text-13px'>
                      {item.name}
                    </Typography.Text>
                    {!item.isDirectory && item.size !== undefined && (
                      <Typography.Text type='secondary' className='shrink-0 text-11px'>
                        {(item.size / 1024).toFixed(1)} KB
                      </Typography.Text>
                    )}
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>

        <div className='flex items-center gap-8px'>
          <Typography.Text type='secondary' className='shrink-0 text-12px'>
            {t('conversation.remoteFileBrowser.path')}:
          </Typography.Text>
          <Input
            size='small'
            value={manualPath}
            onChange={setManualPath}
            onPressEnter={handleManualPathSubmit}
            onBlur={handleManualPathSubmit}
          />
        </div>
      </div>
    </AionModal>
  );
};

export default RemoteFileBrowserModal;
