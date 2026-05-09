/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { RemoteAgentConfig, RemoteAgentInput } from '@process/agent/remote/types';
import type {
  RemoteAgentProtocol,
  RemoteConnectionConfig,
  WslConnectionConfig,
  SshConnectionConfig,
} from '@/common/types/detectedAgent';
import { isWslConfig, isSshConfig } from '@/common/types/detectedAgent';
import EmojiPicker from '@/renderer/components/chat/EmojiPicker';
import { openExternalUrl } from '@/renderer/utils/platform';
import ProtocolPicker from './components/ProtocolPicker';
import WslFields from './components/WslFields';
import SshFields from './components/SshFields';
import HostKeyConfirmModal from './components/HostKeyConfirmModal';
import TestConnectionStatus, { type TestStep } from './components/TestConnectionStatus';
import {
  Avatar,
  Button,
  Form,
  Input,
  Link,
  Message,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  Typography,
} from '@arco-design/web-react';
import AionModal from '@/renderer/components/base/AionModal';
import { Attention, Edit, Plus, ReduceOne, Robot, Speed } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

const FormItem = Form.Item;

const PAIRING_POLL_INTERVAL = 5_000;
const PAIRING_TIMEOUT = 5 * 60 * 1000;
const REMOTE_AGENT_GUIDE_URL = 'https://github.com/iOfficeAI/AionUi/wiki/Remote-Agent-Guide-Chinese';

type PairingState = 'idle' | 'handshaking' | 'pending' | 'timeout';

const formatTimeLeft = (ms: number): string => {
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
};

const statusColor = (status?: string): string => {
  switch (status) {
    case 'connected':
      return 'green';
    case 'pending':
      return 'orange';
    case 'error':
      return 'red';
    default:
      return 'gray';
  }
};

const openRemoteAgentGuide = (): void => {
  void openExternalUrl(REMOTE_AGENT_GUIDE_URL).catch(console.error);
};

const RemoteAgentFormModal: React.FC<{
  visible: boolean;
  editAgent?: RemoteAgentConfig;
  onClose: () => void;
  onSaved: () => void;
}> = ({ visible, editAgent, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm<RemoteAgentInput>();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeProtocol, setActiveProtocol] = useState<RemoteAgentProtocol>('openclaw');
  const [avatar, setAvatar] = useState<string>('\u{1F916}');
  const [pairingState, setPairingState] = useState<PairingState>('idle');
  const [pairingTimeLeft, setPairingTimeLeft] = useState(0);
  const [testStatus, setTestStatus] = useState<TestStep>('');
  const [hostKeyInfo, setHostKeyInfo] = useState<{ id?: string; fingerprint: string } | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const countdownRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const savedAgentIdRef = useRef<string>(undefined);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startPairingPoll = useCallback(
    (agentId: string) => {
      setPairingState('pending');
      setPairingTimeLeft(PAIRING_TIMEOUT);
      const startedAt = Date.now();

      countdownRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, PAIRING_TIMEOUT - elapsed);
        setPairingTimeLeft(remaining);
        if (remaining <= 0) {
          stopPolling();
          setPairingState('timeout');
        }
      }, 1_000);

      pollTimerRef.current = setInterval(async () => {
        try {
          const result = await ipcBridge.remoteAgent.handshake.invoke({ id: agentId });
          if (result.status === 'ok') {
            stopPolling();
            setPairingState('idle');
            Message.success(t('settings.remoteAgent.created'));
            onSaved();
            onClose();
          }
          // pending_approval → keep polling
        } catch {
          // ignore, keep polling
        }
      }, PAIRING_POLL_INTERVAL);
    },
    [stopPolling, onSaved, onClose, t]
  );

  const buildConnectionConfig = useCallback(
    (values: Record<string, unknown>): RemoteConnectionConfig | undefined => {
      if (activeProtocol === 'wsl') {
        const distro = values.wsl_distro as string | undefined;
        const cliCommand = values.wsl_cliCommand as string | undefined;
        if (!distro || !cliCommand) return undefined;
        const extraArgsRaw = (values.wsl_extraArgs as string | undefined) ?? '';
        const cliArgs = extraArgsRaw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const cfg: WslConnectionConfig = {
          distro,
          cliCommand,
          customCliPath: (values.wsl_customCliPath as string | undefined) || undefined,
          cliArgs,
          workingDir: (values.wsl_workingDir as string | undefined) || undefined,
          transportMode: ((values.wsl_transportMode as string | undefined) ?? 'stream-json') as WslConnectionConfig['transportMode'],
        };
        return cfg;
      }
      if (activeProtocol === 'ssh') {
        const host = values.ssh_host as string | undefined;
        const username = values.ssh_username as string | undefined;
        const privateKeyPath = values.ssh_privateKeyPath as string | undefined;
        const cliCommand = values.ssh_cliCommand as string | undefined;
        if (!host || !username || !privateKeyPath || !cliCommand) return undefined;
        const extraArgsRaw = (values.ssh_extraArgs as string | undefined) ?? '';
        const cliArgs = extraArgsRaw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const cfg: SshConnectionConfig = {
          host,
          port: Number(values.ssh_port ?? 22),
          username,
          privateKeyPath,
          // Plaintext — bridge will encrypt at the trust boundary. Never sent
          // to or persisted at the renderer.
          passphrase: (values.ssh_passphrase as string | undefined) || undefined,
          cliCommand,
          customCliPath: (values.ssh_customCliPath as string | undefined) || undefined,
          cliArgs,
          workingDir: (values.ssh_workingDir as string | undefined) || undefined,
          transportMode: ((values.ssh_transportMode as string | undefined) ?? 'stream-json') as SshConnectionConfig['transportMode'],
        };
        return cfg;
      }
      return undefined;
    },
    [activeProtocol]
  );

  const handleTestConnection = useCallback(async () => {
    const values = form.getFieldsValue() as Record<string, unknown>;
    if (activeProtocol === 'openclaw' && !values.url) {
      Message.warning(t('settings.remoteAgent.urlRequired'));
      return;
    }
    setTesting(true);
    setTestStatus(activeProtocol === 'wsl' ? 'detectingWsl' : activeProtocol === 'ssh' ? 'connecting' : '');
    try {
      const connectionConfig = buildConnectionConfig(values);
      const result = await ipcBridge.remoteAgent.testConnection.invoke({
        protocol: activeProtocol,
        url: values.url as string | undefined,
        authType: (values.authType as string | undefined) ?? 'none',
        authToken: values.authToken as string | undefined,
        allowInsecure: values.allowInsecure as boolean | undefined,
        connectionConfig,
      });
      if (result.status === 'host_key_approval_required' && result.fingerprint) {
        setHostKeyInfo({ fingerprint: result.fingerprint });
        setTestStatus('');
      } else if (result.success) {
        Message.success(t('settings.remoteAgent.testSuccess'));
        setTestStatus('ready');
      } else {
        Message.error(t('settings.remoteAgent.testFailed', { error: result.error }));
        setTestStatus('');
      }
    } catch (error) {
      Message.error(t('settings.remoteAgent.testError', { error: String(error) }));
      setTestStatus('');
    } finally {
      setTesting(false);
    }
  }, [form, t, activeProtocol, buildConnectionConfig]);

  const handleHostKeyConfirm = useCallback(async () => {
    if (!hostKeyInfo) return;
    const sshHost = (form.getFieldsValue() as Record<string, unknown>).ssh_host as string | undefined;
    const sshPort = Number((form.getFieldsValue() as Record<string, unknown>).ssh_port ?? 22);
    if (sshHost) {
      await ipcBridge.remoteAgent.acceptHostKey.invoke({
        id: savedAgentIdRef.current,
        host: sshHost,
        port: sshPort,
        fingerprint: hostKeyInfo.fingerprint,
      });
    }
    setHostKeyInfo(null);
    handleTestConnection();
  }, [hostKeyInfo, handleTestConnection, form]);

  const handleSave = useCallback(async () => {
    try {
      const values = (await form.validate()) as Record<string, unknown>;
      setSaving(true);

      const connectionConfig = buildConnectionConfig(values);
      const payload: RemoteAgentInput = {
        name: values.name as string,
        protocol: activeProtocol,
        url: (values.url as string | undefined) ?? '',
        authType: ((values.authType as string | undefined) ?? 'none') as RemoteAgentInput['authType'],
        authToken: values.authToken as string | undefined,
        allowInsecure: values.allowInsecure as boolean | undefined,
        connectionConfig,
        avatar,
      };

      let agentId: string;
      if (editAgent) {
        await ipcBridge.remoteAgent.update.invoke({ id: editAgent.id, updates: payload });
        agentId = editAgent.id;
      } else {
        const created = await ipcBridge.remoteAgent.create.invoke(payload);
        agentId = created.id;
      }
      savedAgentIdRef.current = agentId;

      // For openclaw protocol, perform full handshake
      if (activeProtocol === 'openclaw') {
        setPairingState('handshaking');
        const result = await ipcBridge.remoteAgent.handshake.invoke({ id: agentId });

        if (result.status === 'ok') {
          Message.success(editAgent ? t('settings.remoteAgent.updated') : t('settings.remoteAgent.created'));
          onSaved();
          onClose();
        } else if (result.status === 'pending_approval') {
          startPairingPoll(agentId);
          onSaved();
        } else {
          Message.warning(
            `${editAgent ? t('settings.remoteAgent.updated') : t('settings.remoteAgent.created')} — ${result.error || 'Handshake failed'}`
          );
          onSaved();
          onClose();
        }
      } else {
        Message.success(editAgent ? t('settings.remoteAgent.updated') : t('settings.remoteAgent.created'));
        onSaved();
        onClose();
      }
    } catch (err) {
      // Validation errors come back as a record without a `message`; only show
      // a banner for actual API/runtime failures so the user can act on them.
      const message = err instanceof Error ? err.message : '';
      if (message) {
        Message.error(message);
      }
    } finally {
      setSaving(false);
    }
  }, [form, editAgent, activeProtocol, avatar, onSaved, onClose, startPairingPoll, t, buildConnectionConfig]);

  const handleCancelPairing = useCallback(() => {
    stopPolling();
    setPairingState('idle');
    onSaved();
    onClose();
  }, [stopPolling, onSaved, onClose]);

  // Render pairing waiting UI
  if (pairingState === 'pending' || pairingState === 'timeout') {
    return (
      <AionModal
        visible={visible}
        onCancel={handleCancelPairing}
        header={{
          title: editAgent ? t('settings.remoteAgent.editTitle') : t('settings.remoteAgent.addTitle'),
          showClose: true,
        }}
        style={{ maxWidth: '92vw', borderRadius: 16 }}
        contentStyle={{
          background: 'var(--dialog-fill-0)',
          borderRadius: 16,
          padding: '20px 24px 16px',
          overflow: 'auto',
        }}
        footer={{
          render: () => <Button onClick={handleCancelPairing}>{t('settings.remoteAgent.pendingCancel')}</Button>,
        }}
        afterClose={() => {
          stopPolling();
          setPairingState('idle');
          form.resetFields();
        }}
      >
        <div className='flex flex-col items-center gap-16px py-32px'>
          {pairingState === 'pending' ? (
            <>
              <Spin size={32} />
              <Typography.Text className='text-16px font-medium'>
                {t('settings.remoteAgent.pendingApproval')}
              </Typography.Text>
              <Typography.Text type='secondary'>{t('settings.remoteAgent.pendingApprovalHint')}</Typography.Text>
              <Typography.Text type='secondary' className='text-12px'>
                {t('settings.remoteAgent.pendingTimeRemaining', { time: formatTimeLeft(pairingTimeLeft) })}
              </Typography.Text>
            </>
          ) : (
            <>
              <Typography.Text className='text-16px font-medium' type='warning'>
                {t('settings.remoteAgent.pendingTimeout')}
              </Typography.Text>
            </>
          )}
        </div>
      </AionModal>
    );
  }

  return (
    <AionModal
      visible={visible}
      onCancel={onClose}
      header={{
        title: editAgent ? t('settings.remoteAgent.editTitle') : t('settings.remoteAgent.addTitle'),
        showClose: true,
      }}
      style={{ maxWidth: '92vw', borderRadius: 16 }}
      contentStyle={{
        background: 'var(--dialog-fill-0)',
        borderRadius: 16,
        padding: '20px 24px 16px',
        overflow: 'auto',
      }}
      okText={pairingState === 'handshaking' ? t('settings.remoteAgent.handshaking') : t('settings.remoteAgent.save')}
      cancelText={t('settings.remoteAgent.cancel')}
      onOk={handleSave}
      confirmLoading={saving || pairingState === 'handshaking'}
      afterOpen={() => {
        if (editAgent) {
          setActiveProtocol(editAgent.protocol);
          setAvatar(editAgent.avatar || '\u{1F916}');
          const baseValues: Record<string, unknown> = {
            name: editAgent.name,
            url: editAgent.url,
            authType: editAgent.authType,
            authToken: editAgent.authToken,
            allowInsecure: editAgent.allowInsecure,
          };
          if (isWslConfig(editAgent.connectionConfig)) {
            const c = editAgent.connectionConfig;
            baseValues.wsl_distro = c.distro;
            baseValues.wsl_cliCommand = c.cliCommand;
            baseValues.wsl_customCliPath = c.customCliPath;
            baseValues.wsl_workingDir = c.workingDir;
            baseValues.wsl_extraArgs = (c.cliArgs ?? []).join('\n');
            baseValues.wsl_transportMode = c.transportMode ?? 'stream-json';
          } else if (isSshConfig(editAgent.connectionConfig)) {
            const c = editAgent.connectionConfig;
            baseValues.ssh_host = c.host;
            baseValues.ssh_port = c.port;
            baseValues.ssh_username = c.username;
            baseValues.ssh_privateKeyPath = c.privateKeyPath;
            // Do NOT pre-fill the passphrase. Showing ciphertext or plaintext
            // here is unsafe; the user re-enters the passphrase only when
            // changing it, and an empty value preserves the existing one.
            baseValues.ssh_passphrase = '';
            baseValues.ssh_cliCommand = c.cliCommand;
            baseValues.ssh_customCliPath = c.customCliPath;
            baseValues.ssh_workingDir = c.workingDir;
            baseValues.ssh_extraArgs = (c.cliArgs ?? []).join('\n');
            baseValues.ssh_transportMode = c.transportMode ?? 'stream-json';
          }
          form.setFieldsValue(baseValues as never);
        } else {
          setActiveProtocol('openclaw');
          setAvatar('\u{1F916}');
          form.setFieldsValue({ authType: 'none' } as never);
        }
      }}
      afterClose={() => {
        setPairingState('idle');
        setTestStatus('');
        setHostKeyInfo(null);
        form.resetFields();
      }}
    >
      <div className='flex flex-col gap-16px pt-8px pb-20px'>
        <div className='flex gap-10px rounded-12px border border-solid border-[rgba(var(--warning-6),0.14)] bg-[rgba(var(--warning-6),0.08)] px-16px py-12px'>
          <Attention theme='filled' size={16} className='mt-2px shrink-0 text-[rgb(var(--warning-6))]' />
          <div className='min-w-0 text-13px leading-20px text-t-secondary'>
            <span>{t('settings.agentManagement.remoteAgentsDescription')} </span>
            <Link className='text-13px leading-20px' onClick={openRemoteAgentGuide}>
              {t('settings.remoteAgent.guideAction')}
            </Link>
          </div>
        </div>

        {/* Avatar + Name row */}
        <div className='flex items-center gap-12px'>
          <EmojiPicker onChange={(emoji) => setAvatar(emoji)}>
            <div className='cursor-pointer shrink-0'>
              <Avatar
                size={48}
                shape='square'
                style={{ backgroundColor: 'var(--color-fill-2)', fontSize: 24, borderRadius: 12 }}
              >
                {avatar}
              </Avatar>
            </div>
          </EmojiPicker>
          <div className='flex-1 min-w-0'>
            <Form form={form} layout='vertical' autoComplete='off'>
              <FormItem
                field='name'
                rules={[{ required: true, message: t('settings.remoteAgent.nameRequired') }]}
                style={{ marginBottom: 0 }}
              >
                <Input size='large' placeholder={t('settings.remoteAgent.namePlaceholder')} />
              </FormItem>
            </Form>
          </div>
        </div>

        {/* Connection fields */}
        <Form form={form} layout='vertical' autoComplete='off'>
          <ProtocolPicker value={activeProtocol as RemoteAgentProtocol} onChange={(p) => setActiveProtocol(p)} />

          {activeProtocol === 'openclaw' && (
            <>
              <FormItem
                label={t('settings.remoteAgent.url')}
                field='url'
                rules={[{ required: true, message: t('settings.remoteAgent.urlRequired') }]}
              >
                <Input placeholder='wss://example.com/gateway' />
              </FormItem>

              <FormItem label={t('settings.remoteAgent.authType')} field='authType' rules={[{ required: true }]}>
                <Select>
                  <Select.Option value='none'>{t('settings.remoteAgent.authNone')}</Select.Option>
                  <Select.Option value='bearer'>{t('settings.remoteAgent.authBearer')}</Select.Option>
                </Select>
              </FormItem>

              <Form.Item shouldUpdate noStyle>
                {(values: Record<string, unknown>) =>
                  values.authType === 'bearer' ? (
                    <FormItem
                      label={t('settings.remoteAgent.authToken')}
                      field='authToken'
                      rules={[{ required: true, message: t('settings.remoteAgent.tokenRequired') }]}
                    >
                      <Input.Password placeholder={t('settings.remoteAgent.tokenPlaceholder')} />
                    </FormItem>
                  ) : null
                }
              </Form.Item>

              <Form.Item shouldUpdate noStyle>
                {(values: Record<string, unknown>) =>
                  typeof values.url === 'string' && values.url.startsWith('wss://') ? (
                    <FormItem
                      label={t('settings.remoteAgent.allowInsecure')}
                      field='allowInsecure'
                      triggerPropName='checked'
                      extra={
                        <Typography.Text type='secondary' className='text-12px'>
                          {t('settings.remoteAgent.allowInsecureHint')}
                        </Typography.Text>
                      }
                    >
                      <Switch />
                    </FormItem>
                  ) : null
                }
              </Form.Item>
            </>
          )}

          {activeProtocol === 'wsl' && <WslFields />}
          {activeProtocol === 'ssh' && (
            <SshFields
              onBrowseKey={async () => {
                const paths = await ipcBridge.dialog.showOpen.invoke({
                  properties: ['openFile'],
                  filters: [
                    { name: 'SSH Keys', extensions: ['*'] },
                    { name: 'PEM', extensions: ['pem', 'key'] },
                  ],
                });
                if (paths && paths[0]) {
                  form.setFieldsValue({ ssh_privateKeyPath: paths[0] } as never);
                }
              }}
            />
          )}

          <div className='flex items-center justify-between gap-12px mt-12px'>
            <TestConnectionStatus protocol={activeProtocol as RemoteAgentProtocol} status={testStatus} />
            <Button
              type='outline'
              icon={<Speed theme='outline' size='14' />}
              loading={testing}
              onClick={handleTestConnection}
            >
              {t('settings.remoteAgent.testConnection')}
            </Button>
          </div>
        </Form>
      </div>

      <HostKeyConfirmModal
        visible={!!hostKeyInfo}
        fingerprint={hostKeyInfo?.fingerprint ?? ''}
        onConfirm={handleHostKeyConfirm}
        onCancel={() => setHostKeyInfo(null)}
      />
    </AionModal>
  );
};

const protocolTagColor = (protocol?: RemoteAgentProtocol): string => {
  switch (protocol) {
    case 'wsl':
      return 'green';
    case 'ssh':
      return 'orange';
    default:
      return 'arcoblue';
  }
};

const buildAgentSummary = (agent: RemoteAgentConfig): string => {
  if (agent.protocol === 'wsl' && isWslConfig(agent.connectionConfig)) {
    const c = agent.connectionConfig;
    const cli = c.customCliPath || c.cliCommand;
    return `WSL: ${c.distro} / ${cli}`;
  }
  if (agent.protocol === 'ssh' && isSshConfig(agent.connectionConfig)) {
    const c = agent.connectionConfig;
    const cli = c.customCliPath || c.cliCommand;
    return `${c.username}@${c.host}:${c.port} / ${cli}`;
  }
  return agent.url;
};

const RemoteAgentManagement: React.FC = () => {
  const { t } = useTranslation();
  const { data: agents, mutate } = useSWR('remote-agents.list', () => ipcBridge.remoteAgent.list.invoke());
  const [modalVisible, setModalVisible] = useState(false);
  const [editAgent, setEditAgent] = useState<RemoteAgentConfig>();
  const remoteActionButtonClassName = '!rounded-10px !px-10px';

  const handleAdd = useCallback(() => {
    setEditAgent(undefined);
    setModalVisible(true);
  }, []);

  const handleEdit = useCallback((agent: RemoteAgentConfig) => {
    setEditAgent(agent);
    setModalVisible(true);
  }, []);

  const handleDelete = useCallback(
    async (agent: RemoteAgentConfig) => {
      Modal.confirm({
        title: t('settings.remoteAgent.deleteConfirm'),
        content: t('settings.remoteAgent.deleteConfirmContent', { name: agent.name }),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          await ipcBridge.remoteAgent.delete.invoke({ id: agent.id });
          Message.success(t('settings.remoteAgent.deleted'));
          await mutate();
        },
      });
    },
    [t, mutate]
  );

  const handleSaved = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return (
    <div className='flex flex-col gap-16px py-16px'>
      <div className='flex flex-wrap items-start justify-between gap-12px'>
        <div className='flex flex-1 flex-wrap items-center gap-x-6px gap-y-2px px-16px'>
          <Typography.Text type='secondary' className='text-12px leading-18px text-t-secondary'>
            {t('settings.agentManagement.remoteAgentsDescription')}
          </Typography.Text>
          <Link className='text-12px leading-18px' onClick={openRemoteAgentGuide}>
            {t('settings.remoteAgent.guideAction')}
          </Link>
        </div>
        <Button
          type='outline'
          shape='round'
          size='small'
          icon={<Plus size='16' />}
          onClick={handleAdd}
          className='rd-100px border-1 border-solid border-[var(--color-border-2)] h-34px px-14px text-t-secondary hover:text-t-primary'
        >
          {t('settings.remoteAgent.add')}
        </Button>
      </div>

      {!agents || agents.length === 0 ? (
        <div className='flex flex-col items-center gap-12px py-48px'>
          <Typography.Text type='secondary' className='text-14px'>
            {t('settings.remoteAgent.emptyTitle')}
          </Typography.Text>
          <Button
            type='outline'
            shape='round'
            size='small'
            icon={<Plus size='16' />}
            onClick={handleAdd}
            className='rd-100px border-1 border-solid border-[var(--color-border-2)] h-34px px-14px text-t-secondary hover:text-t-primary'
          >
            {t('settings.remoteAgent.emptyAction')}
          </Button>
        </div>
      ) : (
        <div className='grid grid-cols-1 gap-12px px-16px md:grid-cols-2 xl:grid-cols-3'>
          {agents.map((agent) => (
            <div
              key={agent.id}
              className='flex min-h-[214px] flex-col rounded-12px border border-solid border-[var(--color-border-2)] bg-[var(--color-bg-2)] p-14px transition-colors hover:border-[var(--color-border-3)]'
            >
              <div className='mb-12px flex justify-center'>
                <Avatar
                  size={48}
                  shape='square'
                  style={{ backgroundColor: 'var(--color-fill-2)', fontSize: 24, flexShrink: 0 }}
                >
                  {agent.avatar || <Robot theme='outline' size='18' />}
                </Avatar>
              </div>

              <div className='mb-10px text-center'>
                <Typography.Text className='block text-14px font-medium leading-20px line-clamp-2'>
                  {agent.name}
                </Typography.Text>
              </div>

              <div className='mb-10px flex min-h-[24px] flex-wrap items-center justify-center gap-6px'>
                {agent.status && agent.status !== 'unknown' && (
                  <Tag size='small' color={statusColor(agent.status)}>
                    {agent.status}
                  </Tag>
                )}
                <Tag size='small' color={protocolTagColor(agent.protocol)}>
                  {agent.protocol}
                </Tag>
              </div>

              <Typography.Text
                type='secondary'
                className='mb-14px block min-h-[36px] text-center text-12px line-clamp-2'
              >
                {buildAgentSummary(agent)}
              </Typography.Text>

              <div className='mt-auto grid grid-cols-2 gap-8px'>
                <Button
                  size='small'
                  type='secondary'
                  icon={<Edit theme='outline' size='14' />}
                  className={remoteActionButtonClassName}
                  onClick={() => handleEdit(agent)}
                >
                  {t('common.edit', { defaultValue: 'Edit' })}
                </Button>
                <Button
                  size='small'
                  type='secondary'
                  status='danger'
                  icon={<ReduceOne theme='outline' size='14' />}
                  className={remoteActionButtonClassName}
                  onClick={() => void handleDelete(agent)}
                >
                  {t('common.delete', { defaultValue: 'Delete' })}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <RemoteAgentFormModal
        visible={modalVisible}
        editAgent={editAgent}
        onClose={() => setModalVisible(false)}
        onSaved={handleSaved}
      />
    </div>
  );
};

export default RemoteAgentManagement;
