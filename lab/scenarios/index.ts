import type { Scenario } from '../src/scenario';
import { redisAuthMismatch } from './cache/redis-auth-mismatch';
import { pgWalFull } from './db/pg-wal-full';
import { diskNearlyFull } from './system/disk-nearly-full';
import { noisyNeighbour } from './system/noisy-neighbour';
import { healthySystem } from './trap/healthy-system';
import { certExpired } from './web/cert-expired';
import { nginxBadConfig } from './web/nginx-bad-config';
import { upstream502 } from './web/upstream-502';

/** Every task, in the order a campaign runs them. */
export const SCENARIOS: Scenario[] = [nginxBadConfig, pgWalFull, certExpired, upstream502, noisyNeighbour, diskNearlyFull, redisAuthMismatch, healthySystem];
