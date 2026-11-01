import { UdmtError } from './errors.js';
import type { OperationStatus } from './types.js';

/**
 * Single source of truth for operation transitions (roadmap 12.2).
 * UI and CLI render from this table; neither may invent a status.
 */
export const TERMINAL_STATUSES: OperationStatus[] = [
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
  'interrupted',
];

const TRANSITIONS: Record<OperationStatus, OperationStatus[]> = {
  queued: ['preparing', 'preflight', 'cancel_requested', 'cancelled', 'failed', 'interrupted'],
  preparing: ['preflight', 'running', 'finalizing', 'failed', 'cancel_requested', 'cancelled', 'interrupted'],
  preflight: ['running', 'finalizing', 'failed', 'cancel_requested', 'cancelled', 'interrupted'],
  running: ['finalizing', 'verifying', 'failed', 'cancel_requested', 'interrupted'],
  finalizing: ['verifying', 'failed', 'cancel_requested', 'interrupted', 'completed'],
  verifying: ['completed', 'completed_with_warnings', 'failed', 'cancel_requested', 'interrupted'],
  cancel_requested: ['cancelled', 'failed', 'interrupted'],
  retry_waiting: ['queued', 'cancelled', 'failed'],
  completed: [],
  completed_with_warnings: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OperationStatus, to: OperationStatus, runId: string): void {
  if (!canTransition(from, to)) {
    throw new UdmtError('CONFLICT', `Illegal status transition ${from} -> ${to} for run ${runId}`, {
      details: { from, to, run_id: runId },
    });
  }
}

export function isTerminal(status: OperationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: OperationStatus): boolean {
  return ['queued', 'preparing', 'preflight', 'running', 'finalizing', 'verifying', 'cancel_requested'].includes(status);
}
