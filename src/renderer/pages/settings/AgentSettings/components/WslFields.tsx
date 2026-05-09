/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Form, Input, Select, Button, Typography } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';

const FormItem = Form.Item;

const CLI_PRESETS = ['claude', 'codex', 'gemini', 'custom'] as const;

interface WslFieldsProps {
  formNamespace?: string;
}

const WslFields: React.FC<WslFieldsProps> = () => {
  const { t } = useTranslation();
  const [distros, setDistros] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchDistros = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const list = await ipcBridge.remoteAgent.listWslDistros.invoke();
      if (signal?.aborted) return;
      setDistros(list);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDistros(controller.signal);
    return () => controller.abort();
  }, [fetchDistros]);

  return (
    <>
      <FormItem label={t('settings.remoteAgent.wslDistro')} field='wsl_distro' rules={[{ required: true }]}>
        <Select
          loading={loading}
          placeholder={t('settings.remoteAgent.wslDistroPlaceholder')}
          notFoundContent={
            <span className='text-12px text-t-tertiary'>{t('settings.remoteAgent.wslDistroNotFound')}</span>
          }
          suffixIcon={
            <Button
              size='mini'
              type='text'
              icon={<Refresh theme='outline' size='14' />}
              onClick={(e) => {
                e.stopPropagation();
                void fetchDistros();
              }}
            />
          }
        >
          {distros.map((d) => (
            <Select.Option key={d} value={d}>
              {d}
            </Select.Option>
          ))}
        </Select>
      </FormItem>

      <FormItem label={t('settings.remoteAgent.cliCommand')} field='wsl_cliCommand' rules={[{ required: true }]}>
        <Select>
          {CLI_PRESETS.map((c) => (
            <Select.Option key={c} value={c}>
              {c === 'custom' ? t('settings.remoteAgent.cliCommandCustom') : c}
            </Select.Option>
          ))}
        </Select>
      </FormItem>

      <Form.Item shouldUpdate noStyle>
        {(values) =>
          values.wsl_cliCommand === 'custom' ? (
            <FormItem
              label={t('settings.remoteAgent.customCliPath')}
              field='wsl_customCliPath'
              rules={[{ required: true }]}
            >
              <Input placeholder='/usr/local/bin/my-cli' />
            </FormItem>
          ) : null
        }
      </Form.Item>

      <FormItem
        label={t('settings.remoteAgent.workingDir')}
        field='wsl_workingDir'
        extra={
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.remoteAgent.workingDirHintWsl')}
          </Typography.Text>
        }
      >
        <Input placeholder='/home/xuan' />
      </FormItem>

      <FormItem
        label={t('settings.remoteAgent.extraArgs')}
        field='wsl_extraArgs'
        extra={
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.remoteAgent.extraArgsHint')}
          </Typography.Text>
        }
      >
        <Input.TextArea placeholder='--verbose' autoSize={{ minRows: 2, maxRows: 4 }} />
      </FormItem>

      <FormItem
        label={t('settings.remoteAgent.transportMode')}
        field='wsl_transportMode'
        initialValue='stream-json'
        extra={
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.remoteAgent.transportModeHint')}
          </Typography.Text>
        }
      >
        <Select>
          <Select.Option value='stream-json'>{t('settings.remoteAgent.transportModeStreamJson')}</Select.Option>
          <Select.Option value='simple-stdin'>{t('settings.remoteAgent.transportModeSimple')}</Select.Option>
          <Select.Option value='acp'>{t('settings.remoteAgent.transportModeAcp')}</Select.Option>
        </Select>
      </FormItem>
    </>
  );
};

export default WslFields;
