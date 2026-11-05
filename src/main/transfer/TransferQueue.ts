import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  PauseController,
  TransferPipeline,
  getBaseName,
  isDirectoryPath,
  joinPaths,
  type TransferOptions,
} from './TransferPipeline';
import { SAME_FILE_ERROR, isSameFileOnProvider, resolverFor } from './transferPaths';
import type {
  IStorageProvider,
  TransferProgress,
} from '../../shared/types/storage';

export interface TransferJobOptions {
  id?: string;
  sourceProvider: IStorageProvider;
  sourcePath: string;
  targetProvider: IStorageProvider;
  targetPath: string;
  isDirectory?: boolean;
  totalBytes?: number;
  verifyIntegrity?: boolean;
  verifyChecksum?: boolean | 'sha256' | 'md5';
  expectedChecksum?: string;
}

export interface TransferJob {
  id: string;
  sourceProvider: IStorageProvider;
  sourcePath: string;
  targetProvider: IStorageProvider;
  targetPath: string;
  isDirectory: boolean;
  progress: TransferProgress;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  verifyIntegrity?: boolean;
  verifyChecksum?: boolean | 'sha256' | 'md5';
  expectedChecksum?: string;
}

export interface TransferQueueOptions {
  concurrency?: number;
  pipeline?: TransferPipeline;
}

interface InternalJobContext {
  job: TransferJob;
  abortController: AbortController;
  pauseController: PauseController;
  waitPromise: Promise<TransferJob>;
  resolveWait: (job: TransferJob) => void;
}

/**
 * Manages concurrent streaming file transfer jobs with concurrency limits,
 * pausing, resuming, cancellation, and progress event emission.
 */
export class TransferQueue extends EventEmitter {
  private _concurrency: number;
  private readonly pipeline: TransferPipeline;
  private jobs: TransferJob[] = [];
  private contexts = new Map<string, InternalJobContext>();
  private activeJobIds = new Set<string>();

  constructor(options: TransferQueueOptions = {}) {
    super();
    this._concurrency = options.concurrency !== undefined ? options.concurrency : 3;
    this.pipeline = options.pipeline ?? new TransferPipeline();
  }

  get concurrency(): number {
    return this._concurrency;
  }

  set concurrency(value: number) {
    this._concurrency = Math.max(0, value);
    this.processQueue();
  }

  getJobs(): TransferJob[] {
    return [...this.jobs];
  }

  getJob(jobId: string): TransferJob | undefined {
    return this.jobs.find((j) => j.id === jobId);
  }

  getActiveJobs(): TransferJob[] {
    return this.jobs.filter((j) => this.activeJobIds.has(j.id));
  }

  getPendingJobs(): TransferJob[] {
    return this.jobs.filter((j) => j.progress.status === 'pending');
  }

  getActiveTransferCount(): number {
    return this.jobs.filter(
      (j) =>
        j.progress.status === 'pending' ||
        j.progress.status === 'running' ||
        j.progress.status === 'paused'
    ).length;
  }

  hasActiveTransfers(): boolean {
    return this.getActiveTransferCount() > 0;
  }

  cancelAll(): void {
    for (const job of this.jobs) {
      if (
        job.progress.status === 'pending' ||
        job.progress.status === 'running' ||
        job.progress.status === 'paused'
      ) {
        this.cancelJob(job.id);
      }
    }
  }

  addJob(options: TransferJobOptions): TransferJob {
    const id = options.id ?? crypto.randomUUID();
    if (this.contexts.has(id)) {
      throw new Error(`Job with id "${id}" already exists in queue`);
    }

    const fileName =
      getBaseName(options.sourcePath) || options.sourcePath || 'job';

    const progress: TransferProgress = {
      jobId: id,
      fileName,
      transferredBytes: 0,
      totalBytes: options.totalBytes ?? 0,
      percentage: 0,
      bytesPerSecond: 0,
      status: 'pending',
    };

    const job: TransferJob = {
      id,
      sourceProvider: options.sourceProvider,
      sourcePath: options.sourcePath,
      targetProvider: options.targetProvider,
      targetPath: options.targetPath,
      isDirectory: options.isDirectory ?? false,
      verifyIntegrity: options.verifyIntegrity,
      verifyChecksum: options.verifyChecksum,
      expectedChecksum: options.expectedChecksum,
      progress,
      createdAt: new Date(),
    };

    const abortController = new AbortController();
    const pauseController = new PauseController();

    let resolveWait!: (job: TransferJob) => void;
    const waitPromise = new Promise<TransferJob>((resolve) => {
      resolveWait = resolve;
    });

    this.jobs.push(job);
    this.contexts.set(id, {
      job,
      abortController,
      pauseController,
      waitPromise,
      resolveWait,
    });

    this.emit('jobAdded', job);
    this.processQueue();

    return job;
  }

  pauseJob(jobId: string): boolean {
    const context = this.contexts.get(jobId);
    if (!context) return false;
    const { job, pauseController } = context;

    if (job.progress.status === 'running') {
      pauseController.pause();
      job.progress.status = 'paused';
      this.emit('paused', job);
      this.emit('progress', job.progress, job);
      return true;
    }

    if (job.progress.status === 'pending') {
      job.progress.status = 'paused';
      this.emit('paused', job);
      this.emit('progress', job.progress, job);
      return true;
    }

    return false;
  }

  resumeJob(jobId: string): boolean {
    const context = this.contexts.get(jobId);
    if (!context) return false;
    const { job, pauseController } = context;

    if (job.progress.status === 'paused') {
      if (this.activeJobIds.has(job.id)) {
        pauseController.resume();
        job.progress.status = 'running';
        this.emit('resumed', job);
        this.emit('progress', job.progress, job);
        return true;
      } else {
        job.progress.status = 'pending';
        this.emit('resumed', job);
        this.emit('progress', job.progress, job);
        queueMicrotask(() => this.processQueue());
        return true;
      }
    }

    return false;
  }

  cancelJob(jobId: string): boolean {
    const context = this.contexts.get(jobId);
    if (!context) return false;
    const { job, abortController, pauseController } = context;

    if (
      job.progress.status === 'completed' ||
      job.progress.status === 'failed' ||
      job.progress.status === 'cancelled'
    ) {
      return false;
    }

    job.progress.status = 'cancelled';

    if (this.activeJobIds.has(job.id)) {
      pauseController.abort();
      abortController.abort();
      // Cancellation event will be finalized when runJob catches the abort
    } else {
      this.emit('cancelled', job);
      this.emit('progress', job.progress, job);
      context.resolveWait(job);
      this.checkDrain();
    }

    return true;
  }

  clearCompleted(): TransferJob[] {
    const removed: TransferJob[] = [];
    this.jobs = this.jobs.filter((job) => {
      if (job.progress.status === 'completed') {
        removed.push(job);
        this.contexts.delete(job.id);
        return false;
      }
      return true;
    });
    return removed;
  }

  async waitForJob(jobId: string): Promise<TransferJob> {
    const context = this.contexts.get(jobId);
    if (!context) {
      // The context is released when a job finishes; a finished job is still in `jobs`.
      const finished = this.jobs.find((j) => j.id === jobId);
      if (finished) return finished;
      throw new Error(`Job not found: ${jobId}`);
    }
    return context.waitPromise;
  }

  waitForAll(): Promise<void> {
    return new Promise<void>((resolve) => {
      const isDone = () => {
        const remaining = this.jobs.filter(
          (j) =>
            j.progress.status === 'pending' ||
            j.progress.status === 'running' ||
            j.progress.status === 'paused'
        );
        return remaining.length === 0;
      };

      if (isDone()) {
        resolve();
        return;
      }

      const onDone = () => {
        if (isDone()) {
          this.off('completed', onDone);
          this.off('failed', onDone);
          this.off('cancelled', onDone);
          resolve();
        }
      };

      this.on('completed', onDone);
      this.on('failed', onDone);
      this.on('cancelled', onDone);
    });
  }

  onProgress(
    callback: (progress: TransferProgress, job: TransferJob) => void
  ): this {
    return this.on('progress', callback);
  }

  onCompleted(callback: (job: TransferJob) => void): this {
    return this.on('completed', callback);
  }

  onError(callback: (job: TransferJob, error: Error) => void): this {
    return this.on('failed', callback);
  }

  private processQueue(): void {
    if (this._concurrency <= 0) return;

    while (this.activeJobIds.size < this._concurrency) {
      const nextJob = this.jobs.find(
        (j) => j.progress.status === 'pending' && !this.activeJobIds.has(j.id)
      );

      if (!nextJob) {
        break;
      }

      const context = this.contexts.get(nextJob.id);
      if (!context) {
        break;
      }

      this.runJob(context);
    }
  }

  private async runJob(context: InternalJobContext): Promise<void> {
    const { job, abortController, pauseController } = context;
    this.activeJobIds.add(job.id);
    job.startedAt = new Date();
    job.progress.status = 'running';
    if (job.isDirectory) {
      job.progress.statusMessage = 'Preparing...';
    }
    this.emit('progress', job.progress, job);

    try {
      if (!job.isDirectory) {
        let isSpecial = false;
        try {
          const srcStat = await job.sourceProvider.stat(job.sourcePath);
          isSpecial = Boolean(srcStat.isSpecial);
          if (srcStat.isDirectory) {
            job.isDirectory = true;
          }
          if (
            (job.progress.totalBytes === undefined || job.progress.totalBytes === 0) &&
            srcStat.size > 0
          ) {
            job.progress.totalBytes = srcStat.size;
          }
        } catch {
          // ignore
        }
        if (isSpecial) {
          // A FIFO, socket or device: reading it would block, and there is nothing to copy.
          throw new Error(`Not a regular file: ${getBaseName(job.sourcePath) || job.sourcePath}`);
        }
      }

      let resolvedTargetPath = job.targetPath;
      const baseName = getBaseName(job.sourcePath);
      if (
        baseName &&
        getBaseName(resolvedTargetPath) !== baseName &&
        (await isDirectoryPath(job.targetProvider, resolvedTargetPath))
      ) {
        resolvedTargetPath = joinPaths(job.targetProvider.type, resolvedTargetPath, baseName);
      }

      // Same provider and same file: opening the target would truncate the source before it is read.
      if (
        job.sourceProvider === job.targetProvider &&
        (await isSameFileOnProvider(job.sourceProvider.type, job.sourcePath, resolvedTargetPath, resolverFor(job.sourceProvider)))
      ) {
        throw new Error(SAME_FILE_ERROR);
      }

      const transferOptions: TransferOptions = {
        jobId: job.id,
        sourceProvider: job.sourceProvider,
        sourcePath: job.sourcePath,
        targetProvider: job.targetProvider,
        targetPath: resolvedTargetPath,
        totalBytes: job.progress.totalBytes,
        signal: abortController.signal,
        pauseController,
        emitCompleted: false,
        verifyIntegrity: job.verifyIntegrity,
        verifyChecksum: job.verifyChecksum,
        expectedChecksum: job.expectedChecksum,
        onProgress: (p) => {
          if (
            job.progress.status !== 'cancelled' &&
            job.progress.status !== 'paused'
          ) {
            job.progress = p;
            this.emit('progress', p, job);
          }
        },
      };

      if (job.isDirectory) {
        await this.pipeline.transferDirectory(transferOptions);
      } else {
        await this.pipeline.transferFile(transferOptions);
      }

      const currentStatus = job.progress.status as TransferProgress['status'];
      if (currentStatus === 'cancelled' || abortController.signal.aborted) {
        // The cancel arrived while the copy was finishing (e.g. during the integrity checks, which do not
        // look at the abort signal), so nothing threw. The job still needs its terminal state and its
        // waiters released, or it would sit as "running" for ever (M8).
        this.finishCancelled(job, context);
      } else {
        job.progress.status = 'completed';
        job.progress.percentage = 100;
        job.completedAt = new Date();
        job.progress.statusMessage = 'Done';
        this.emit('progress', job.progress, job);
        this.emit('completed', job);
        context.resolveWait(job);
      }
    } catch (err: any) {
      const currentStatus = job.progress.status as TransferProgress['status'];
      if (
        abortController.signal.aborted ||
        currentStatus === 'cancelled' ||
        err.name === 'AbortError'
      ) {
        this.finishCancelled(job, context);
      } else {
        job.progress.status = 'failed';
        job.error = err?.message || String(err);
        job.progress.error = job.error;
        job.progress.statusMessage = 'Failed';
        this.emit('progress', job.progress, job);
        this.emit('failed', job, err);
        context.resolveWait(job);
      }
    } finally {
      this.activeJobIds.delete(job.id);
      this.contexts.delete(job.id);
      this.processQueue();
      this.checkDrain();
    }
  }

  /** Terminal state of a cancelled job that was running: final progress, the event, and the waiters released. */
  private finishCancelled(job: TransferJob, context: InternalJobContext): void {
    job.progress.status = 'cancelled';
    job.progress.statusMessage = 'Cancelled';
    this.emit('progress', job.progress, job);
    this.emit('cancelled', job);
    context.resolveWait(job);
  }

  private checkDrain(): void {
    const activeOrPending = this.jobs.filter(
      (j) =>
        j.progress.status === 'pending' ||
        j.progress.status === 'running' ||
        j.progress.status === 'paused'
    );
    if (activeOrPending.length === 0) {
      this.emit('drain');
    }
  }
}
