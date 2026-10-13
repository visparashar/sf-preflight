// SPDX-License-Identifier: Apache-2.0
import { Worker } from "node:worker_threads";

/**
 * Long-lived worker threads for sf-preflight's analysis. Starting a worker means loading the
 * analyzer and its parse cache again; with typing analysis that happens on every pause, so workers
 * are kept and reused. At most `size` stay idle; extra ones (for jobs outside the editor's own limit)
 * end after their job. An idle worker ends after `idleMs`, a job that runs past `timeoutMs` ends its
 * worker, and a worker that crashes is replaced on the next job.
 */
export class WorkerPool {
  private readonly idle: { worker: Worker; timer: NodeJS.Timeout; onExit: () => void }[] = [];
  private readonly busy = new Set<Worker>();
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly script: string,
    private readonly opts: { size: number; idleMs: number; timeoutMs: number; timeoutMessage: string },
  ) {}

  /** Workers alive right now (idle or busy). */
  get alive(): number {
    return this.idle.length + this.busy.size;
  }

  run<T>(req: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("sf-preflight is shutting down."));
    const worker = this.take();
    this.busy.add(worker);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        this.busy.delete(worker);
      };
      const fail = (err: Error, kill: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (kill) void worker.terminate();
        reject(err);
      };
      const onMessage = (msg: { id?: number; ok: boolean; value?: T; error?: string }) => {
        if (msg?.id !== id || settled) return;
        settled = true;
        cleanup();
        this.release(worker);
        if (msg.ok) resolve(msg.value as T);
        else reject(new Error(msg.error ?? "sf-preflight failed"));
      };
      const onError = (err: Error) => fail(err, true);
      const onExit = (code: number) => fail(new Error(`sf-preflight stopped unexpectedly (exit code ${code}).`), false);
      const timer = setTimeout(() => fail(new Error(this.opts.timeoutMessage), true), this.opts.timeoutMs);
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.postMessage({ id, req });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const { worker, timer, onExit } of this.idle.splice(0)) {
      clearTimeout(timer);
      worker.off("exit", onExit);
      void worker.terminate();
    }
    for (const worker of this.busy) void worker.terminate();
    this.busy.clear();
  }

  private take(): Worker {
    const kept = this.idle.pop();
    if (kept) {
      clearTimeout(kept.timer);
      kept.worker.off("exit", kept.onExit);
      kept.worker.ref();
      return kept.worker;
    }
    return new Worker(this.script);
  }

  private release(worker: Worker): void {
    if (this.disposed || this.idle.length >= this.opts.size) {
      void worker.terminate();
      return;
    }
    const drop = () => {
      const i = this.idle.indexOf(entry);
      if (i >= 0) this.idle.splice(i, 1);
    };
    const entry = {
      worker,
      onExit: drop,
      timer: setTimeout(() => {
        drop();
        worker.off("exit", drop);
        void worker.terminate();
      }, this.opts.idleMs),
    };
    entry.timer.unref();
    // An idle worker must never keep the editor's process alive; one that dies leaves the pool.
    worker.unref();
    worker.once("exit", drop);
    this.idle.push(entry);
  }
}
