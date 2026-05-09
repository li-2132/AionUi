/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Modal, Typography } from '@arco-design/web-react';
import { Attention } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

interface HostKeyConfirmModalProps {
  visible: boolean;
  fingerprint: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const HostKeyConfirmModal: React.FC<HostKeyConfirmModalProps> = ({ visible, fingerprint, onConfirm, onCancel }) => {
  const { t } = useTranslation();

  return (
    <Modal
      title={t('settings.remoteAgent.hostKeyTitle')}
      visible={visible}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={t('settings.remoteAgent.hostKeyTrust')}
      cancelText={t('settings.remoteAgent.hostKeyCancel')}
      okButtonProps={{ status: 'warning' }}
    >
      <div className='flex flex-col gap-12px'>
        <div className='flex gap-10px p-12px rounded-8px border border-solid border-[rgba(var(--warning-6),0.2)] bg-[rgba(var(--warning-6),0.08)]'>
          <Attention theme='filled' size={18} className='shrink-0 mt-2px text-[rgb(var(--warning-6))]' />
          <Typography.Text className='text-13px leading-20px'>
            {t('settings.remoteAgent.hostKeyWarning')}
          </Typography.Text>
        </div>
        <div className='p-10px rounded-6px bg-[var(--color-fill-2)] font-mono text-12px break-all'>{fingerprint}</div>
      </div>
    </Modal>
  );
};

export default HostKeyConfirmModal;
