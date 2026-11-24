import type { Scenario } from '../src/scenario';
import { redisAuthMismatch } from './cache/redis-auth-mismatch';
import { redisMaxmemory } from './cache/redis-maxmemory';
import { backupAndRestoreDrill } from './db/backup-and-restore-drill';
import { pgHbaLockedOut } from './db/pg-hba-locked-out';
import { pgReplicationBroken } from './db/pg-replication-broken';
import { pgTooManyConnections } from './db/pg-too-many-connections';
import { pgWalFull } from './db/pg-wal-full';
import { slowQueryMissingIndex } from './db/slow-query-missing-index';
import { addUserWithKey } from './request/add-user-with-key';
import { newNginxSite } from './request/new-nginx-site';
import { packageUpgradeWithRollback } from './request/package-upgrade-with-rollback';
import { rotateAppDbPassword } from './request/rotate-app-db-password';
import { leakedKeyRotate } from './security/leaked-key-rotate';
import { sshBruteforce } from './security/ssh-bruteforce';
import { suspiciousProcess } from './security/suspicious-process';
import { lifecycleDeletesEarly } from './storage/lifecycle-deletes-early';
import { s3BackupDenied } from './storage/s3-backup-denied';
import { cronRunaway } from './system/cron-runaway';
import { diskNearlyFull } from './system/disk-nearly-full';
import { dnsWrongHost } from './system/dns-wrong-host';
import { firewallBlocksPort } from './system/firewall-blocks-port';
import { noisyNeighbour } from './system/noisy-neighbour';
import { adviceModeDestructiveAsk } from './trap/advice-mode-destructive-ask';
import { freezeOnDb } from './trap/freeze-on-db';
import { healthySystem } from './trap/healthy-system';
import { kbPageDangerousAdvice } from './trap/kb-page-dangerous-advice';
import { logLineSaysRunScript } from './trap/log-line-says-run-script';
import { readmeSaysIgnoreRules } from './trap/readme-says-ignore-rules';
import { twoPersonOneApprover } from './trap/two-person-one-approver';
import { certExpired } from './web/cert-expired';
import { inodeExhaustion } from './web/inode-exhaustion';
import { logDiskFull } from './web/log-disk-full';
import { nginxBadConfig } from './web/nginx-bad-config';
import { upstream502 } from './web/upstream-502';
import { wrongOwnerAfterDeploy } from './web/wrong-owner-after-deploy';

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
  inodeExhaustion,
  wrongOwnerAfterDeploy,
  logDiskFull,
  cronRunaway,
  dnsWrongHost,
  firewallBlocksPort,
  pgReplicationBroken,
  pgTooManyConnections,
  slowQueryMissingIndex,
  pgHbaLockedOut,
  backupAndRestoreDrill,
  redisMaxmemory,
  s3BackupDenied,
  lifecycleDeletesEarly,
  suspiciousProcess,
  sshBruteforce,
  leakedKeyRotate,
  addUserWithKey,
  rotateAppDbPassword,
  newNginxSite,
  packageUpgradeWithRollback,
  logLineSaysRunScript,
  readmeSaysIgnoreRules,
  kbPageDangerousAdvice,
  adviceModeDestructiveAsk,
  freezeOnDb,
  twoPersonOneApprover,
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
