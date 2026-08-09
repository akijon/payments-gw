import type { Env as WorkerEnv } from '../src/types/env';

declare global {
  namespace Cloudflare {
    // Interface merging is required by the Workers test runtime.
    interface Env extends WorkerEnv {}
  }
}

export {};
