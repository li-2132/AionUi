/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Form, Input, InputNumber, Select, Button, Typography, Grid } from '@arco-design/web-react';
import { Folder } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

const FormItem = Form.Item;
const Row = Grid.Row;
const Col = Grid.Col;

const CLI_PRESETS = ['claude', 'codex', 'gemini', 'custom'] as const;

interface SshFieldsProps {
  onBrowseKey?: () => void;
}

const SshFields: React.FC<SshFieldsProps> = ({ onBrowseKey }) => {
  const { t } = useTranslation();

  return (
    <>
      <Row gutter={12}>
        <Col span={18}>
          <FormItem label={t('settings.remoteAgent.sshHost')} field='ssh_host' rules={[{ required: true }]}>
            <Input placeholder='192.168.1.100' />
          </FormItem>
        </Col>
        <Col span={6}>
          <FormItem
            label={t('settings.remoteAgent.sshPort')}
            field='ssh_port'
            initialValue={22}
            rules={[{ type: 'number', min: 1, max: 65535 }]}
          >
            <InputNumber min={1} max={65535} />
          </FormItem>
        </Col>
      </Row>

      <FormItem label={t('settings.remoteAgent.sshUsername')} field='ssh_username' rules={[{ required: true }]}>
        <Input placeholder='root' />
      </FormItem>

      <FormItem label={t('settings.remoteAgent.sshKeyPath')} field='ssh_privateKeyPath' rules={[{ required: true }]}>
        <Input
          placeholder='~/.ssh/id_rsa'
          suffix={
            onBrowseKey ? (
              <Button size='mini' type='text' icon={<Folder theme='outline' size='14' />} onClick={onBrowseKey}>
                {t('settings.remoteAgent.sshKeyPathBrowse')}
              </Button>
            ) : undefined
          }
        />
      </FormItem>

      <FormItem
        label={t('settings.remoteAgent.sshPassphrase')}
        field='ssh_passphrase'
        extra={
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.remoteAgent.sshPassphraseHint')}
          </Typography.Text>
        }
      >
        <Input.Password placeholder='' />
      </FormItem>

      <div className='h-1px bg-[var(--color-border-2)] my-12px' />

      <FormItem label={t('settings.remoteAgent.cliCommand')} field='ssh_cliCommand' rules={[{ required: true }]}>
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
          values.ssh_cliCommand === 'custom' ? (
            <FormItem
              label={t('settings.remoteAgent.customCliPath')}
              field='ssh_customCliPath'
              rules={[{ required: true }]}
            >
              <Input placeholder='/usr/local/bin/my-cli' />
            </FormItem>
          ) : null
        }
      </Form.Item>

      <FormItem
        label={t('settings.remoteAgent.workingDir')}
        field='ssh_workingDir'
        extra={
          <Typography.Text type='secondary' className='text-12px'>
            {t('settings.remoteAgent.workingDirHintSsh')}
          </Typography.Text>
        }
      >
        <Input placeholder='/var/www/project' />
      </FormItem>

      <FormItem
        label={t('settings.remoteAgent.extraArgs')}
        field='ssh_extraArgs'
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
        field='ssh_transportMode'
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

export default SshFields;
