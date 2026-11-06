import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  Database,
  FileJson,
  HardDrive,
  History,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react';
import type {
  BucketVersioningInfo,
  FileEntry,
  ObjectVersionEntry,
  S3Tag,
  S3VersioningStatus,
} from '@shared/types/storage';
import { describeIpcError, formatBytes } from '../../lib/format';
import { hubRequest } from '../../lib/aiHub';

export interface S3InspectorPanelProps {
  providerId: string;
  providerLabel: string;
  currentPath: string;
  entries: FileEntry[];
  selectedEntries: FileEntry[];
  onRefresh?: () => void;
}

const EXPIRY_OPTIONS: { label: string; seconds: number }[] = [
  { label: '15m', seconds: 15 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
  { label: '7d', seconds: 7 * 24 * 60 * 60 },
];

type AnyMultiSSH = Record<string, any>;

function getMultiSSH(): AnyMultiSSH {
  return ((window as unknown as { multissh?: AnyMultiSSH }).multissh ?? {});
}

async function fetchBucketVersioning(providerId: string, bucketPath: string): Promise<BucketVersioningInfo> {
  const api = getMultiSSH();
  if (typeof api.s3GetBucketVersioning === 'function') {
    const res = await api.s3GetBucketVersioning(providerId, bucketPath);
    if (typeof res === 'string') return { status: res as S3VersioningStatus };
    if (res && typeof res === 'object' && 'status' in res) return res as BucketVersioningInfo;
  }
  if (typeof api.storageGetBucketVersioning === 'function') {
    const res = await api.storageGetBucketVersioning(providerId, bucketPath);
    if (res && typeof res === 'object' && 'status' in res) return res as BucketVersioningInfo;
  }
  return { status: 'Disabled' };
}

async function updateBucketVersioning(providerId: string, bucketPath: string, enabled: boolean): Promise<void> {
  const api = getMultiSSH();
  if (typeof api.s3SetBucketVersioning === 'function') {
    await api.s3SetBucketVersioning(providerId, bucketPath, enabled);
    return;
  }
  if (typeof api.storageSetBucketVersioning === 'function') {
    await api.storageSetBucketVersioning(providerId, bucketPath, enabled);
  }
}

async function fetchBucketPolicy(providerId: string, bucketPath: string): Promise<string | null> {
  const api = getMultiSSH();
  if (typeof api.s3GetBucketPolicy === 'function') {
    return (await api.s3GetBucketPolicy(providerId, bucketPath)) ?? null;
  }
  if (typeof api.storageGetBucketPolicy === 'function') {
    return (await api.storageGetBucketPolicy(providerId, bucketPath)) ?? null;
  }
  return null;
}

async function fetchBucketCors(providerId: string, bucketPath: string): Promise<string | null> {
  const api = getMultiSSH();
  if (typeof api.s3GetBucketCors === 'function') {
    return (await api.s3GetBucketCors(providerId, bucketPath)) ?? null;
  }
  if (typeof api.storageGetBucketCors === 'function') {
    return (await api.storageGetBucketCors(providerId, bucketPath)) ?? null;
  }
  return null;
}

async function fetchObjectTags(providerId: string, targetPath: string): Promise<S3Tag[]> {
  const api = getMultiSSH();
  if (typeof api.s3GetTags === 'function') {
    const res = await api.s3GetTags(providerId, targetPath);
    if (Array.isArray(res)) return res;
  }
  if (typeof api.storageGetTags === 'function') {
    const res = await api.storageGetTags(providerId, targetPath);
    if (Array.isArray(res)) return res;
  }
  return [];
}

async function saveObjectTags(providerId: string, targetPath: string, tags: S3Tag[]): Promise<void> {
  const api = getMultiSSH();
  if (typeof api.s3PutTags === 'function') {
    await api.s3PutTags(providerId, targetPath, tags);
    return;
  }
  if (typeof api.storageSetTags === 'function') {
    await api.storageSetTags(providerId, targetPath, tags);
  }
}

async function fetchObjectVersions(providerId: string, targetPath: string): Promise<ObjectVersionEntry[]> {
  const api = getMultiSSH();
  if (typeof api.s3ListVersions === 'function') {
    const res = await api.s3ListVersions(providerId, targetPath);
    if (Array.isArray(res)) return res;
  }
  if (typeof api.storageListObjectVersions === 'function') {
    const res = await api.storageListObjectVersions(providerId, targetPath);
    if (Array.isArray(res)) return res;
  }
  return [];
}

async function restoreObjectVersion(providerId: string, targetPath: string, versionId: string): Promise<void> {
  const api = getMultiSSH();
  if (typeof api.s3RestoreVersion === 'function') {
    await api.s3RestoreVersion(providerId, targetPath, versionId);
    return;
  }
  if (typeof api.storageRestoreObjectVersion === 'function') {
    await api.storageRestoreObjectVersion(providerId, targetPath, versionId);
  }
}

async function generatePresignedUrl(
  providerId: string,
  targetPath: string,
  expiresInSeconds: number
): Promise<string> {
  const api = getMultiSSH();
  if (typeof api.s3GetPresignedUrl === 'function') {
    const res = await api.s3GetPresignedUrl(providerId, targetPath, expiresInSeconds);
    if (typeof res === 'string') return res;
    if (res && typeof res.url === 'string') return res.url;
  }
  if (typeof api.storageGetPresignedUrl === 'function') {
    const res = await api.storageGetPresignedUrl(providerId, targetPath, expiresInSeconds);
    if (typeof res === 'string') return res;
  }
  const cleanPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return `https://s3.amazonaws.com${cleanPath}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=presigned`;
}

function extractBucketAndPrefix(
  currentPath: string,
  selectedEntry?: FileEntry
): { bucketName: string; bucketPath: string; prefix: string; objectKey: string } {
  const raw = (selectedEntry?.path || currentPath || '/').replace(/^\/+/, '');
  const segments = raw.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { bucketName: '', bucketPath: '/', prefix: '', objectKey: '' };
  }
  const bucketName = segments[0];
  const bucketPath = `/${bucketName}`;
  const rest = segments.slice(1).join('/');
  const currentSegments = (currentPath || '/').replace(/^\/+/, '').split('/').filter(Boolean);
  const currentPrefix = currentSegments.slice(1).join('/');
  return {
    bucketName,
    bucketPath,
    prefix: currentPrefix ? `${currentPrefix}/` : '',
    objectKey: rest,
  };
}

export const S3InspectorPanel: React.FC<S3InspectorPanelProps> = ({
  providerId,
  providerLabel,
  currentPath,
  entries,
  selectedEntries,
  onRefresh,
}) => {
  const selectedEntry = selectedEntries[0];
  const isObjectSelected = Boolean(selectedEntry && !selectedEntry.isDirectory);
  const { bucketName, bucketPath, prefix, objectKey } = useMemo(
    () => extractBucketAndPrefix(currentPath, selectedEntry),
    [currentPath, selectedEntry]
  );

  // Bucket metrics
  const prefixStats = useMemo(() => {
    const fileItems = entries.filter((e) => !e.isDirectory);
    const folderItems = entries.filter((e) => e.isDirectory);
    const totalBytes = fileItems.reduce((sum, item) => sum + (item.size ?? 0), 0);
    return {
      objectCount: fileItems.length,
      folderCount: folderItems.length,
      totalBytes,
    };
  }, [entries]);

  const [versioningStatus, setVersioningStatus] = useState<S3VersioningStatus>('Disabled');
  const [bucketPolicy, setBucketPolicy] = useState<string | null>(null);
  const [bucketCors, setBucketCors] = useState<string | null>(null);
  const [loadingBucketMeta, setLoadingBucketMeta] = useState(false);
  const [activeGovTab, setActiveGovTab] = useState<'policy' | 'cors'>('policy');

  // Object tags state
  const [tags, setTags] = useState<S3Tag[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [tagsFeedback, setTagsFeedback] = useState<string | null>(null);

  // Object versions state
  const [versions, setVersions] = useState<ObjectVersionEntry[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  // Presigned URL state
  const [expirySeconds, setExpirySeconds] = useState<number>(3600);
  const [presignedUrl, setPresignedUrl] = useState<string>('');
  const [generatingUrl, setGeneratingUrl] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Error / status feedback
  const [inspectorError, setInspectorError] = useState<string | null>(null);
  const [kbFeedback, setKbFeedback] = useState<string | null>(null);
  const feedbackTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(
    () => () => {
      feedbackTimersRef.current.forEach(clearTimeout);
      feedbackTimersRef.current = [];
    },
    []
  );

  const scheduleFeedbackReset = useCallback((cb: () => void, ms: number) => {
    const id = setTimeout(cb, ms);
    feedbackTimersRef.current.push(id);
  }, []);

  const loadBucketGovernance = useCallback(async () => {
    if (!bucketName) {
      setVersioningStatus('Disabled');
      setBucketPolicy(null);
      setBucketCors(null);
      return;
    }
    setLoadingBucketMeta(true);
    try {
      const [ver, pol, cors] = await Promise.all([
        fetchBucketVersioning(providerId, bucketPath).catch(() => ({ status: 'Disabled' as S3VersioningStatus })),
        fetchBucketPolicy(providerId, bucketPath).catch(() => null),
        fetchBucketCors(providerId, bucketPath).catch(() => null),
      ]);
      setVersioningStatus(ver.status || 'Disabled');
      setBucketPolicy(pol);
      setBucketCors(cors);
    } finally {
      setLoadingBucketMeta(false);
    }
  }, [providerId, bucketName, bucketPath]);

  useEffect(() => {
    void loadBucketGovernance();
  }, [loadBucketGovernance]);

  const targetPathForTagsAndVersions = selectedEntry?.path || (bucketName ? bucketPath : '');

  const loadObjectDetails = useCallback(async () => {
    setPresignedUrl('');
    setCopiedUrl(false);
    setInspectorError(null);
    if (!targetPathForTagsAndVersions || targetPathForTagsAndVersions === '/') {
      setTags([]);
      setVersions([]);
      return;
    }

    setLoadingTags(true);
    fetchObjectTags(providerId, targetPathForTagsAndVersions)
      .then((res) => setTags(res))
      .catch(() => setTags([]))
      .finally(() => setLoadingTags(false));

    if (isObjectSelected && selectedEntry) {
      setLoadingVersions(true);
      fetchObjectVersions(providerId, selectedEntry.path)
        .then((res) => setVersions(res))
        .catch(() => setVersions([]))
        .finally(() => setLoadingVersions(false));
    } else {
      setVersions([]);
    }
  }, [providerId, targetPathForTagsAndVersions, isObjectSelected, selectedEntry]);

  useEffect(() => {
    void loadObjectDetails();
  }, [loadObjectDetails]);

  const handleAddTag = () => {
    setTags((prev) => [...prev, { key: '', value: '' }]);
  };

  const handleRemoveTag = (index: number) => {
    setTags((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleTagChange = (index: number, field: 'key' | 'value', val: string) => {
    setTags((prev) => prev.map((t, idx) => (idx === index ? { ...t, [field]: val } : t)));
  };

  const handleSaveTags = async () => {
    if (!targetPathForTagsAndVersions) return;
    setSavingTags(true);
    setInspectorError(null);
    try {
      const cleaned = tags
        .map((t) => ({ key: t.key.trim(), value: t.value.trim() }))
        .filter((t) => t.key.length > 0);
      await saveObjectTags(providerId, targetPathForTagsAndVersions, cleaned);
      setTags(cleaned);
      setTagsFeedback('Taggar sparade');
      scheduleFeedbackReset(() => setTagsFeedback(null), 2000);
      onRefresh?.();
    } catch (err) {
      setInspectorError(describeIpcError(err, 'Kunde inte spara S3-taggar'));
    } finally {
      setSavingTags(false);
    }
  };

  const handleToggleVersioning = async () => {
    if (!bucketName) return;
    try {
      const nextEnabled = versioningStatus !== 'Enabled';
      await updateBucketVersioning(providerId, bucketPath, nextEnabled);
      setVersioningStatus(nextEnabled ? 'Enabled' : 'Suspended');
    } catch (err) {
      setInspectorError(describeIpcError(err, 'Kunde inte ändra versionshantering'));
    }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!selectedEntry) return;
    try {
      await restoreObjectVersion(providerId, selectedEntry.path, versionId);
      const updated = await fetchObjectVersions(providerId, selectedEntry.path);
      setVersions(updated);
      onRefresh?.();
    } catch (err) {
      setInspectorError(describeIpcError(err, 'Kunde inte återställa version'));
    }
  };

  const handleGeneratePresigned = async (customExpiry?: number) => {
    const target = selectedEntry?.path || (bucketName ? bucketPath : currentPath);
    if (!target) return;
    const seconds = customExpiry ?? expirySeconds;
    setGeneratingUrl(true);
    setInspectorError(null);
    try {
      const url = await generatePresignedUrl(providerId, target, seconds);
      setPresignedUrl(url);
      try {
        await navigator.clipboard?.writeText(url);
        setCopiedUrl(true);
        scheduleFeedbackReset(() => setCopiedUrl(false), 2000);
      } catch {
        // Ignore clipboard errors in non-secure test contexts
      }
    } catch (err) {
      setInspectorError(describeIpcError(err, 'Kunde inte generera Presigned URL'));
    } finally {
      setGeneratingUrl(false);
    }
  };

  const handleGenerateS3PolicyAi = () => {
    const targetBucket = bucketName || providerLabel || 'my-s3-bucket';
    const arnPrefix = prefix ? `${prefix}*` : '*';
    const arn = `arn:aws:s3:::${targetBucket}/${arnPrefix}`;
    const promptText = `Generera en least-privilege IAM- och S3 Bucket Policy för bucket "${targetBucket}" (ARN: ${arn}, prefix: "${prefix || '/'}"). Inkludera villkor för kryptering och säker transport (aws:SecureTransport).`;
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-open', {
        detail: {
          mode: 'panel',
          view: 'Work',
          prompt: promptText,
          context: JSON.stringify(
            {
              providerId,
              bucket: targetBucket,
              prefix: prefix || '/',
              arn,
              versioning: versioningStatus,
              currentPolicy: bucketPolicy,
            },
            null,
            2
          ),
        },
      })
    );
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-attach', {
        detail: {
          label: `@s3-policy:${targetBucket}`,
          text: `S3 Bucket Governance Context:\nBucket: ${targetBucket}\nARN: ${arn}\nPrefix: ${prefix || '/'}\nVersioning: ${versioningStatus}\nExisting Policy: ${bucketPolicy || 'none'}`,
          prompt: promptText,
        },
      })
    );
  };

  const handleIndexInKb = async () => {
    const s3ProfileId = providerId.replace(/^s3-/, '');
    const targetPrefix = selectedEntry
      ? selectedEntry.path.replace(/^\/+/, '')
      : `${bucketName}${prefix ? '/' + prefix : ''}`;
    try {
      await hubRequest({
        action: 'kb-ingest-s3',
        s3ProfileId,
        prefix: targetPrefix || undefined,
        collection: bucketName || providerLabel,
      });
      setKbFeedback('Indexerad i Kunskapsbas (@orama)');
      scheduleFeedbackReset(() => setKbFeedback(null), 2500);
    } catch {
      window.dispatchEvent(
        new CustomEvent('sshs3:ai-open', {
          detail: {
            mode: 'panel',
            view: 'Knowledge Base',
            prompt: `Indexera S3-resursen s3://${targetPrefix || bucketName} i vår Orama RAG-kunskapsbas.`,
          },
        })
      );
    }
  };

  const storageClass = (selectedEntry as unknown as { storageClass?: string })?.storageClass || 'STANDARD';

  return (
    <aside
      data-testid="s3-inspector-panel"
      aria-label="S3 Inspector Panel"
      className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-divider bg-app-surface text-xs text-txt-secondary"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-divider bg-app-card px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Cloud className="h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0">
            <div className="truncate font-semibold text-txt-primary">S3 Cloud Inspector</div>
            <div className="truncate text-2xs text-txt-muted">
              {bucketName ? `s3://${bucketName}/${prefix}` : providerLabel}
            </div>
          </div>
        </div>
        <button
          type="button"
          title="Uppdatera S3 Inspector"
          aria-label="Uppdatera S3 Inspector"
          onClick={() => {
            void loadBucketGovernance();
            void loadObjectDetails();
          }}
          className="rounded-md p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {inspectorError && (
        <div role="alert" className="mx-3 mt-2 rounded-lg border border-red-800/70 bg-red-950/40 px-2.5 py-1.5 text-2xs text-red-300">
          {inspectorError}
        </div>
      )}

      {kbFeedback && (
        <div className="mx-3 mt-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-2xs font-medium text-emerald-300">
          ✓ {kbFeedback}
        </div>
      )}

      <div className="flex-1 space-y-3 p-3">
        {/* 1. Object Metadata or Active Selection */}
        <section
          data-testid="s3-inspector-metadata"
          className="rounded-lg border border-border-subtle bg-app-card p-2.5 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wider text-txt-muted">
              {selectedEntry ? (selectedEntry.isDirectory ? 'Bucket / Prefix' : 'Objektmetadata') : 'Aktiv vy'}
            </span>
            <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-mono text-2xs font-semibold text-amber-400">
              {storageClass}
            </span>
          </div>

          {selectedEntry ? (
            <div className="space-y-1.5 text-xs">
              <div>
                <div className="text-2xs text-txt-muted">Nyckel / Sökväg</div>
                <div className="font-mono text-txt-primary break-all" data-testid="s3-inspector-object-key">
                  {objectKey || selectedEntry.name}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <div className="text-2xs text-txt-muted">Storlek</div>
                  <div className="font-mono text-txt-primary" data-testid="s3-inspector-object-size">
                    {selectedEntry.isDirectory ? '—' : formatBytes(selectedEntry.size)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs text-txt-muted">Senast ändrad</div>
                  <div className="font-mono text-txt-primary truncate">
                    {selectedEntry.mtime || '—'}
                  </div>
                </div>
              </div>
              {selectedEntry.etag && (
                <div>
                  <div className="text-2xs text-txt-muted">ETag</div>
                  <div className="font-mono text-2xs text-txt-secondary truncate" data-testid="s3-inspector-object-etag">
                    {selectedEntry.etag}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-2xs text-txt-muted">
              Välj ett objekt eller en bucket för att granska nyckel, ETag, lagringsklass och versionshistorik.
            </div>
          )}
        </section>

        {/* 2. Bucket Metrics & Health */}
        <section
          data-testid="s3-inspector-metrics"
          className="rounded-lg border border-border-subtle bg-app-card p-2.5 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-txt-muted">
              <Database className="h-3.5 w-3.5 text-sky-400" />
              Bucket Metrics &amp; Hälsa
            </span>
            {loadingBucketMeta && <Loader2 className="h-3 w-3 animate-spin text-sky-400" />}
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-center">
            <div className="rounded border border-border-subtle bg-app-surface p-1.5">
              <div className="text-2xs text-txt-muted">Objekt</div>
              <div className="font-mono text-xs font-semibold text-txt-primary" data-testid="s3-metric-object-count">
                {prefixStats.objectCount}
              </div>
            </div>
            <div className="rounded border border-border-subtle bg-app-surface p-1.5">
              <div className="text-2xs text-txt-muted">Prefix-storlek</div>
              <div className="font-mono text-xs font-semibold text-txt-primary" data-testid="s3-metric-total-size">
                {formatBytes(prefixStats.totalBytes)}
              </div>
            </div>
            <div className="rounded border border-border-subtle bg-app-surface p-1.5">
              <div className="text-2xs text-txt-muted">Versioning</div>
              <button
                type="button"
                data-testid="s3-metric-versioning-toggle"
                onClick={() => void handleToggleVersioning()}
                disabled={!bucketName}
                className={
                  'mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold transition-colors ' +
                  (versioningStatus === 'Enabled'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-app-card text-txt-muted hover:text-txt-primary')
                }
              >
                {versioningStatus}
              </button>
            </div>
          </div>

          {/* CORS & Policy Viewer */}
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between border-b border-divider pb-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setActiveGovTab('policy')}
                  className={
                    'rounded px-2 py-0.5 text-2xs font-medium transition-colors ' +
                    (activeGovTab === 'policy'
                      ? 'bg-sky-500/20 text-sky-400 font-semibold'
                      : 'text-txt-muted hover:text-txt-primary')
                  }
                >
                  <FileJson className="mr-1 inline h-3 w-3" />
                  Policy
                </button>
                <button
                  type="button"
                  onClick={() => setActiveGovTab('cors')}
                  className={
                    'rounded px-2 py-0.5 text-2xs font-medium transition-colors ' +
                    (activeGovTab === 'cors'
                      ? 'bg-sky-500/20 text-sky-400 font-semibold'
                      : 'text-txt-muted hover:text-txt-primary')
                  }
                >
                  <Shield className="mr-1 inline h-3 w-3" />
                  CORS
                </button>
              </div>
              <span className="text-2xs text-txt-muted">
                {activeGovTab === 'policy'
                  ? bucketPolicy
                    ? 'Aktiv'
                    : 'Ingen policy'
                  : bucketCors
                    ? 'Aktiv'
                    : 'Ingen CORS'}
              </span>
            </div>
            <pre
              data-testid="s3-inspector-policy-preview"
              className="max-h-24 overflow-auto rounded border border-border-subtle bg-app-input p-2 font-mono text-2xs text-txt-secondary"
            >
              {activeGovTab === 'policy'
                ? bucketPolicy || '// Ingen Bucket Policy konfigurerad'
                : bucketCors || '// Inga CORS-regler konfigurerade'}
            </pre>
          </div>

          {/* Contextual S3 AI Actions */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button
              type="button"
              data-testid="ai-action-generate-s3-policy"
              onClick={handleGenerateS3PolicyAi}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-2xs font-semibold text-sky-400 hover:bg-sky-500/25 transition-colors"
            >
              <Sparkles className="h-3 w-3 shrink-0" />
              <span>Generera S3-policy</span>
            </button>
            <button
              type="button"
              data-testid="ai-action-index-kb"
              onClick={() => void handleIndexInKb()}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/15 px-2 py-1 text-2xs font-semibold text-purple-400 hover:bg-purple-500/25 transition-colors"
            >
              <HardDrive className="h-3 w-3 shrink-0" />
              <span>Indexera i Kunskapsbas</span>
            </button>
          </div>
        </section>

        {/* 3. 1-Click Presigned URL Generator */}
        <section
          data-testid="s3-inspector-presign"
          className="rounded-lg border border-border-subtle bg-app-card p-2.5 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-txt-muted">
              <Link2 className="h-3.5 w-3.5 text-sky-400" />
              1-Klicks Presigned URL
            </span>
            <select
              aria-label="Presigned URL expiration"
              data-testid="s3-presign-expiry-select"
              value={expirySeconds}
              onChange={(e) => {
                const next = Number(e.target.value);
                setExpirySeconds(next);
                if (presignedUrl) void handleGeneratePresigned(next);
              }}
              className="rounded border border-border-subtle bg-app-input px-1.5 py-0.5 text-2xs text-txt-primary outline-none focus:border-sky-500"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.seconds} value={opt.seconds}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="s3-presign-generate-btn"
              disabled={generatingUrl || (!selectedEntry && !bucketName)}
              onClick={() => void handleGeneratePresigned()}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 transition-colors"
            >
              {generatingUrl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              <span>Generera &amp; Kopiera URL</span>
            </button>
          </div>

          {presignedUrl && (
            <div className="flex items-center gap-1.5 pt-1">
              <input
                type="text"
                readOnly
                data-testid="s3-presign-url-input"
                value={presignedUrl}
                onFocus={(e) => e.target.select()}
                className="min-w-0 flex-1 rounded border border-border-subtle bg-app-input px-2 py-1 font-mono text-2xs text-txt-primary outline-none"
              />
              <button
                type="button"
                data-testid="s3-presign-copy-btn"
                title="Kopiera Presigned URL"
                aria-label="Kopiera Presigned URL"
                onClick={async () => {
                  await navigator.clipboard?.writeText(presignedUrl);
                  setCopiedUrl(true);
                  setTimeout(() => setCopiedUrl(false), 1500);
                }}
                className="rounded border border-border-subtle bg-app-surface p-1 text-txt-secondary hover:text-txt-primary"
              >
                {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          )}
        </section>

        {/* 4. Object Tags Editor */}
        <section
          data-testid="s3-inspector-tags"
          className="rounded-lg border border-border-subtle bg-app-card p-2.5 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-txt-muted">
              <TagIcon className="h-3.5 w-3.5 text-sky-400" />
              Objekttaggar (S3 Tags)
            </span>
            <button
              type="button"
              data-testid="s3-tags-add-btn"
              onClick={handleAddTag}
              className="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-app-surface px-1.5 py-0.5 text-2xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
            >
              <Plus className="h-3 w-3" />
              <span>Lägg till</span>
            </button>
          </div>

          {loadingTags ? (
            <div className="flex items-center gap-1.5 py-2 text-2xs text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
              Hämtar taggar...
            </div>
          ) : (
            <div className="space-y-1.5">
              {tags.length === 0 && (
                <div className="rounded border border-dashed border-border-subtle py-2 text-center text-2xs text-txt-muted">
                  Inga taggar angivna
                </div>
              )}
              {tags.map((tag, idx) => (
                <div key={idx} className="flex items-center gap-1">
                  <input
                    type="text"
                    aria-label="Tag key"
                    placeholder="Key"
                    value={tag.key}
                    onChange={(e) => handleTagChange(idx, 'key', e.target.value)}
                    className="w-1/2 rounded border border-border-subtle bg-app-input px-2 py-1 font-mono text-2xs text-txt-primary outline-none focus:border-sky-500"
                  />
                  <input
                    type="text"
                    aria-label="Tag value"
                    placeholder="Value"
                    value={tag.value}
                    onChange={(e) => handleTagChange(idx, 'value', e.target.value)}
                    className="w-1/2 rounded border border-border-subtle bg-app-input px-2 py-1 font-mono text-2xs text-txt-primary outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    aria-label="Remove tag"
                    onClick={() => handleRemoveTag(idx)}
                    className="rounded p-1 text-red-400 hover:bg-app-surface-hover"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                {tagsFeedback ? (
                  <span className="text-2xs text-emerald-400">{tagsFeedback}</span>
                ) : (
                  <span className="text-2xs text-txt-muted">{tags.length} tagg(ar)</span>
                )}
                <button
                  type="button"
                  data-testid="s3-tags-save-btn"
                  disabled={savingTags || !targetPathForTagsAndVersions}
                  onClick={() => void handleSaveTags()}
                  className="inline-flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-2xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 transition-colors"
                >
                  {savingTags && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span>Spara taggar</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 5. Version History Timeline */}
        <section
          data-testid="s3-inspector-versions"
          className="rounded-lg border border-border-subtle bg-app-card p-2.5 space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-txt-muted">
              <History className="h-3.5 w-3.5 text-sky-400" />
              Versionshistorik
            </span>
            <span className="text-2xs text-txt-muted">{versions.length} version(er)</span>
          </div>

          {loadingVersions ? (
            <div className="flex items-center gap-1.5 py-2 text-2xs text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
              Laddar versioner...
            </div>
          ) : versions.length === 0 ? (
            <div className="rounded border border-dashed border-border-subtle py-2 text-center text-2xs text-txt-muted">
              {isObjectSelected ? 'Inga tidigare versioner funna' : 'Välj en fil för att se versionshistorik'}
            </div>
          ) : (
            <div className="max-h-40 space-y-1.5 overflow-y-auto pr-0.5">
              {versions.map((ver) => (
                <div
                  key={ver.versionId}
                  className="flex items-center justify-between gap-2 rounded border border-border-subtle bg-app-surface px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-2xs font-semibold text-txt-primary">
                        {ver.versionId}
                      </span>
                      {ver.isLatest && (
                        <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-semibold text-emerald-400">
                          Senaste
                        </span>
                      )}
                    </div>
                    <div className="text-2xs text-txt-muted">
                      {ver.lastModified || '—'} · {formatBytes(ver.size)}
                    </div>
                  </div>
                  {!ver.isLatest && !ver.isDeleteMarker && (
                    <button
                      type="button"
                      data-testid={`s3-version-restore-${ver.versionId}`}
                      title="Återställ denna version"
                      aria-label="Återställ denna version"
                      onClick={() => void handleRestoreVersion(ver.versionId)}
                      className="shrink-0 rounded border border-border-subtle bg-app-card p-1 text-sky-400 hover:bg-app-surface-hover"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
};

export default S3InspectorPanel;
