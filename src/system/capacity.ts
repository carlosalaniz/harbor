import { availableParallelism, totalmem } from 'node:os';
import type { HostCapacity } from '../planner/resources.js';

// Decision 205: this machine's size. CPU and memory limits are bounded by it, and a limit at or above it is dropped.
export function hostCapacity(): HostCapacity {
  return { cpus: availableParallelism(), memoryMiB: Math.floor(totalmem() / (1024 * 1024)) };
}
