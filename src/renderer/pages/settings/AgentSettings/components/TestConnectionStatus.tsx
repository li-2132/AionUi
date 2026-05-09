/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Spin, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { RemoteAgentProtocol } from '@/common/types/detectedAgent';

const SSH_STEPS = ['initializing', 'connecting', 'authenticating', 'startingCli', 'ready'] as const;
const WSL_STEPS = ['detectingWsl', 'startingDistro', 'spawningCli', 'ready'] as const;

export type TestStep = (typeof SSH_STEPS)[number] | (typeof WSL_STEPS)[number] | '';

interface TestConnectionStatusProps {
  protocol: RemoteAgentProtocol;
  status: TestStep;
}

const TestConnectionStatus: React.FC<TestConnectionStatusProps> = ({ protocol, status }) => {
  const { t } = useTranslation();
  if (!status) return null;

  const label = t(`settings.remoteAgent.testStep_${status}`);
  const isReady = status === 'ready';
  const steps: readonly string[] = protocol === 'wsl' ? WSL_STEPS : protocol === 'ssh' ? SSH_STEPS : [];
  const currentIdx = steps.indexOf(status);

  return (
    <div className='flex items-center gap-8px'>
      {!isReady && <Spin size={14} />}
      <Typography.Text type={isReady ? 'success' : 'secondary'} className='text-12px'>
        {steps.length > 0 && currentIdx >= 0 ? `${currentIdx + 1}/${steps.length} · ${label}` : label}
      </Typography.Text>
    </div>
  );
};

export default TestConnectionStatus;
