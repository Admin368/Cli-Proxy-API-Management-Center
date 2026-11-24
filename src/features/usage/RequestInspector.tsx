import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { apiClient } from '@/services/api/client';
import { logsApi, responseDataToText } from '@/services/api/logs';
import type { UsageRecord } from '@/services/api/usageRecords';
import { parseRequestLog } from './requestLog';
import styles from './RequestInspector.module.scss';

export function RequestInspector({
  record,
  account,
  onClose,
}: {
  record: UsageRecord;
  account: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'request' | 'response'>('request');
  const [content, setContent] = useState<ReturnType<typeof parseRequestLog> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const revision = apiClient.getConnectionRevision();
    const controller = new AbortController();
    if (!record.requestId) {
      setError('inspect_missing');
      return;
    }
    void (async () => {
      try {
        const response = await logsApi.downloadRequestLogById(record.requestId!, {
          signal: controller.signal,
        });
        if (response.data instanceof Blob && response.data.size > 4_000_000)
          throw new Error('size');
        const text = await responseDataToText(response.data);
        if (text.length > 4_000_000) throw new Error('size');
        if (active && revision === apiClient.getConnectionRevision())
          setContent(parseRequestLog(text));
      } catch {
        if (active && revision === apiClient.getConnectionRevision())
          setError('inspect_unavailable');
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [record]);
  return (
    <Modal open title={t('usage.inspect')} width="min(1100px, 95vw)" onClose={onClose}>
      <div className={styles.summary}>
        <strong>{record.model}</strong>
        <span>{account}</span>
        <span>{new Date(record.timestamp).toLocaleString()}</span>
        <span>
          {t('usage.tokens')}: {record.total?.toLocaleString() ?? '—'}
        </span>
        <span>
          {t('usage.input')}: {record.input?.toLocaleString() ?? '—'}
        </span>
        <span>
          {t('usage.output')}: {record.output?.toLocaleString() ?? '—'}
        </span>
        <span>
          {t('usage.timing')}: {record.latencyMs === null ? '—' : `${record.latencyMs / 1000}s`}
        </span>
        {content?.status && <span>HTTP {content.status}</span>}
      </div>
      <p>{t('usage.inspect_hint')}</p>
      <div className={styles.summary} role="group" aria-label={t('usage.inspect')}>
        {(['request', 'response'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={tab === value ? 'primary' : 'secondary'}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {t(`usage.inspect_${value}`)}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert">{t(`usage.${error}`)}</p>
      ) : !content ? (
        <p role="status">{t('common.loading')}</p>
      ) : (
        <pre className={styles.body}>{content[tab] || t('usage.inspect_empty')}</pre>
      )}
    </Modal>
  );
}
