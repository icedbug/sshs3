import type { Scenario } from '../src/scenario';
import { redisAuthMismatch } from './cache/redis-auth-mismatch';
import { redisMaxmemory } from './cache/redis-maxmemory';
import { backupAndRestoreDrill } from './db/backup-and-restore-drill';
import { pgHbaLockedOut } from './db/pg-hba-locked-out';
import { pgReplicationBroken } from './db/pg-replication-broken';
import { pgTooManyConnections } from './db/pg-too-many-connections';
import { pgWalFull } from './db/pg-wal-full';
import { slowQueryMissingIndex } from './db/slow-query-missing-index';
import { lifecycleDeletesEarly } from './storage/lifecycle-deletes-early';
import { s3BackupDenied } from './storage/s3-backup-denied';
import { diskNearlyFull } from './system/disk-nearly-full';
import { noisyNeighbour } from './system/noisy-neighbour';
import { healthySystem } from './trap/healthy-system';
import { certExpired } from './web/cert-expired';
import { nginxBadConfig } from './web/nginx-bad-config';
import { upstream502 } from './web/upstream-502';

/** Every task, in the order a campaign runs them. */
export const SCENARIOS: Scenario[] = [
  nginxBadConfig,
  pgWalFull,
  certExpired,
  upstream502,
  noisyNeighbour,
  diskNearlyFull,
  redisAuthMismatch,
  healthySystem,
  pgReplicationBroken,
  pgTooManyConnections,
  slowQueryMissingIndex,
  pgHbaLockedOut,
  backupAndRestoreDrill,
  redisMaxmemory,
  s3BackupDenied,
  lifecycleDeletesEarly,
];

/** Tasks written but not yet shown right three times: `validate` takes them, a campaign does not. */
export const CANDIDATES: Scenario[] = [];

const NO_KUBERNETES = 'Kubernetes (kind) cannot run on this machine: runc inside the kind node fails (lab/.state/k8s-<n>.reason).';

/** Tasks the design names that are not in the library, and why. A report lists them. */
export const LEFT_OUT: Array<{ id: string; reason: string }> = [
  { id: 'oom-killed-service', reason: "A service's memory limit is not enforced inside these containers, and a real out-of-memory kill would reach the whole machine." },
  { id: 'k8s-crashloop-config', reason: NO_KUBERNETES },
  { id: 'k8s-image-typo', reason: NO_KUBERNETES },
  { id: 'k8s-oomkilled', reason: NO_KUBERNETES },
  { id: 'k8s-service-no-endpoints', reason: NO_KUBERNETES },
  { id: 'k8s-rollout-stuck', reason: NO_KUBERNETES },
  { id: 'k8s-scale', reason: NO_KUBERNETES },
];
