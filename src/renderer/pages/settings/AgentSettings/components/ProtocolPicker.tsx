/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Tooltip, Typography } from '@arco-design/web-react';
import { Cloudy, Computer, Connection } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { RemoteAgentProtocol } from '@/common/types/detectedAgent';
import styles from './ProtocolPicker.module.css';

interface ProtocolPickerProps {
  value: RemoteAgentProtocol;
  onChange: (val: RemoteAgentProtocol) => void;
}

type ProtocolOption = {
  key: RemoteAgentProtocol;
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
  disabledOn?: 'non-windows';
};

const OPTIONS: ProtocolOption[] = [
  {
    key: 'openclaw',
    icon: <Cloudy theme='outline' size={24} />,
    titleKey: 'settings.remoteAgent.protocolOpenclaw',
    descKey: 'settings.remoteAgent.protocolOpenclawDesc',
  },
  {
    key: 'wsl',
    icon: <Computer theme='outline' size={24} />,
    titleKey: 'settings.remoteAgent.protocolWsl',
    descKey: 'settings.remoteAgent.protocolWslDesc',
    disabledOn: 'non-windows',
  },
  {
    key: 'ssh',
    icon: <Connection theme='outline' size={24} />,
    titleKey: 'settings.remoteAgent.protocolSsh',
    descKey: 'settings.remoteAgent.protocolSshDesc',
  },
];

const isWindows = (): boolean => navigator.userAgent.toLowerCase().includes('windows');

const ProtocolPicker: React.FC<ProtocolPickerProps> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const onWindows = isWindows();

  return (
    <div className='mb-16px'>
      <Typography.Text className='block mb-8px text-13px font-medium'>
        {t('settings.remoteAgent.protocol')}
      </Typography.Text>
      <div className='grid grid-cols-3 gap-12px'>
        {OPTIONS.map((opt) => {
          const disabled = opt.disabledOn === 'non-windows' && !onWindows;
          const checked = value === opt.key;
          const card = (
            <button
              type='button'
              key={opt.key}
              disabled={disabled}
              aria-pressed={checked}
              onClick={() => !disabled && onChange(opt.key)}
              className={`${styles.card} ${checked ? styles.cardChecked : ''} ${disabled ? styles.cardDisabled : ''}`}
            >
              <div className={`${styles.icon} ${checked ? styles.iconChecked : ''}`} aria-hidden='true'>
                {opt.icon}
              </div>
              <div className='text-13px font-medium mb-2px'>{t(opt.titleKey)}</div>
              <div className='text-11px text-t-tertiary leading-14px'>{t(opt.descKey)}</div>
            </button>
          );
          return disabled ? (
            <Tooltip key={opt.key} content={t('settings.remoteAgent.errorWslNotInstalled')}>
              {card}
            </Tooltip>
          ) : (
            card
          );
        })}
      </div>
    </div>
  );
};

export default ProtocolPicker;
