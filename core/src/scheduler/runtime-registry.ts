import path from 'node:path';
import type { PersonalSchedulerRuntime } from './personal-scheduler-runtime.js';

const runtimes = new Map<string, PersonalSchedulerRuntime>();
const keyFor = (root: string) => path.resolve(root).toLowerCase();

export function registerPersonalSchedulerRuntime(cqrRoot: string, runtime: PersonalSchedulerRuntime): void {
  runtimes.set(keyFor(cqrRoot), runtime);
}

export function unregisterPersonalSchedulerRuntime(cqrRoot: string, runtime: PersonalSchedulerRuntime): void {
  const key = keyFor(cqrRoot);
  if (runtimes.get(key) === runtime) runtimes.delete(key);
}

export function getPersonalSchedulerRuntime(cqrRoot: string): PersonalSchedulerRuntime | null {
  return runtimes.get(keyFor(cqrRoot)) ?? null;
}
