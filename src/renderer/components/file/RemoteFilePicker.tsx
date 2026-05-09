/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import RemoteFileBrowserModal, { type BrowseMode } from './RemoteFileBrowserModal';
import type { RemoteAgentConfig } from '@process/agent/remote/types';

interface RemoteFilePickerProps {
  agentId: string;
  agent: RemoteAgentConfig;
  mode?: BrowseMode;
  initialPath?: string;
  onPick: (path: string) => void;
  children: React.ReactNode;
}

const RemoteFilePicker: React.FC<RemoteFilePickerProps> = ({
  agentId,
  agent,
  mode = 'file',
  initialPath,
  onPick,
  children,
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <span onClick={() => setVisible(true)}>{children}</span>
      {visible && (
        <RemoteFileBrowserModal
          visible
          agentId={agentId}
          agent={agent}
          mode={mode}
          initialPath={initialPath}
          onConfirm={(path) => {
            setVisible(false);
            onPick(path);
          }}
          onCancel={() => setVisible(false)}
        />
      )}
    </>
  );
};

export default RemoteFilePicker;
