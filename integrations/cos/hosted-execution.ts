type Pending = Record<string, number>;
type Mode = 'booting' | 'waiting' | 'paused' | 'running' | 'probe';
const hosted = process.env.COS_EGO_HOSTED === '1';
let mode: Mode = hosted ? (process.env.COS_EGO_PROBE === '1' ? 'probe' : 'booting') : 'running';
let pending: Pending = {};
let start: (() => Promise<void>) | undefined;
let cleanup: (() => Promise<void>) | undefined;
let activation: Promise<ReturnType<typeof egoExecutionStatus>> | undefined;

export function egoExecutionAllowed(): boolean { return !hosted || mode === 'running'; }
export function egoIsProbe(): boolean { return hosted && mode === 'probe'; }
export function egoExecutionStatus() { return { mode, pending: { ...pending }, requiresResume: mode === 'paused' }; }

export function summarizeEgoPending(saved: Record<string, unknown>, globalGoal = false): Pending {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
  const inputs = rows(saved.inputs).filter(row => !['sent', 'cancelled', 'failed'].includes(String(row.state))).length;
  const commands = rows(object(saved.commands).commands).length;
  const swarm = object(saved.swarm);
  const workers = Array.isArray(swarm.activeRuns) ? swarm.activeRuns.length : swarm.runId ? 1 : 0;
  const goals = rows(object(saved.goals).switches).filter(row => row.enabled === true).length + (globalGoal ? 1 : 0);
  const replies = rows(object(saved.replies).replies).filter(row => row.state === 'pending').length;
  const continuations = rows(object(saved.continuations).entries).filter(row => !['committed', 'aborted'].includes(String(row.state))).length;
  return Object.fromEntries(Object.entries({ inputs, commands, workers, goals, replies, continuations }).filter(([, count]) => count > 0));
}

export function configureEgoExecution(saved: Pending, activate: () => Promise<void>, rollback?: () => Promise<void>): void {
  if (!hosted || egoIsProbe()) return;
  pending = saved;
  start = activate;
  cleanup = rollback;
  mode = Object.keys(pending).length ? 'paused' : 'waiting';
}

export async function activateEgoExecution(explicit = false) {
  if (!hosted) return egoExecutionStatus();
  if (egoIsProbe()) throw new Error('CoS maintenance probe cannot execute tasks');
  if (!start) throw new Error('CoS startup is not ready');
  if (activation) return activation;
  if (mode === 'running' || mode === 'paused' && !explicit) return egoExecutionStatus();
  activation = (async () => {
    mode = 'running';
    try { await start!(); pending = {}; return egoExecutionStatus(); }
    catch (error) {
      mode = 'paused';
      await cleanup?.();
      throw error;
    }
  })();
  try { return await activation; } finally { activation = undefined; }
}
