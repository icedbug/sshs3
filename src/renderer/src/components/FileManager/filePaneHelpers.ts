import type React from 'react';
import { Boxes, Cloud, HardDrive, Server } from 'lucide-react';
import type { SourceType } from './types';
import { parentPath } from '../../lib/format';

export function toWebRepoUrl(gitUrl: string): string | undefined {
  const trimmed = gitUrl.trim();
  const scpMatch = /^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/.exec(trimmed);
  if (scpMatch) {
    const [, host, owner, repo] = scpMatch;
    return `https://${host}/${owner}/${repo}`;
  }
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed.replace(/\.git$/, '');
  }
  return undefined;
}

export const SOURCE_ICONS: Record<SourceType, React.ComponentType<{ className?: string }>> = {
  local: HardDrive,
  sftp: Server,
  s3: Cloud,
  k8s: Boxes,
};

/**
 * True when dropping these local paths on `targetPath` would copy items onto themselves: each one
 * already sits directly in the target folder, or is the target itself.
 */
export function isNoopOsDrop(osPaths: string[], targetPath: string): boolean {
  return osPaths.length > 0 && osPaths.every((p) => p === targetPath || parentPath(p) === targetPath);
}

/** Files can be created anywhere except the S3 root, which only holds buckets. */
export function canCreateFileIn(sourceType: SourceType, currentPath: string): boolean {
  return !(sourceType === 's3' && (currentPath === '/' || currentPath === ''));
}
