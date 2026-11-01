import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, assertTransition } from '../../src/core/state-machine.js';
import { UdmtError } from '../../src/core/errors.js';

describe('operation state machine', () => {
  it('allows the documented happy path', () => {
    const path = ['queued', 'preparing', 'preflight', 'running', 'finalizing', 'verifying', 'completed'] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
  });

  it('rejects illegal jumps and terminal resets', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('running', 'completed')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(() => assertTransition('completed', 'running', 'run-1')).toThrow(UdmtError);
  });

  it('treats cancel_requested as non-terminal and requires confirmation for cancelled', () => {
    expect(isTerminal('cancel_requested')).toBe(false);
    expect(canTransition('cancel_requested', 'cancelled')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(false);
    expect(isTerminal('cancelled')).toBe(true);
  });

  it('allows dry-run imports to skip the running stage', () => {
    expect(canTransition('preflight', 'finalizing')).toBe(true);
  });
});
