import { useEffect, useState } from 'react';
import { useAuthStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { authFilesApi } from '@/services/api/authFiles';
import { usageFingerprint } from '@/services/api/usageRecords';
import { compactCredentialLabel } from '@/features/quota/credentialLabel';

/** Labels come from known credential metadata, never arbitrary usage-source strings. */
export function useUsageAccountLabels(scope: string) {
  const connected = useAuthStore((s) => s.connectionStatus === 'connected');
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    const revision = apiClient.getConnectionRevision();
    setLabels(new Map());
    if (connected) {
      void authFilesApi
        .list()
        .then(({ files }) => {
          if (!active || revision !== apiClient.getConnectionRevision()) return;
          const next = new Map<string, string>();
          for (const file of files) {
            const id = String(file.authIndex ?? '').trim();
            if (!id) continue;
            next.set(
              usageFingerprint('auth:' + id),
              file.email?.trim() || compactCredentialLabel(file.name)
            );
          }
          setLabels(next);
        })
        .catch(() => {
          /* Stable anonymous account IDs remain usable if metadata is unavailable. */
        });
    }
    return () => {
      active = false;
    };
  }, [scope, connected]);
  return labels;
}
