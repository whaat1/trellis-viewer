import { expect, it } from 'vitest';
import { ReaderPositionMemory } from './reader-position';
it('keeps the old document scroll during a pending selection and restores each file independently', () => {
  const positions = new ReaderPositionMemory();
  positions.finishCommit('A'); positions.record(140);
  // B is requested but has not committed; continued scrolling still belongs to A.
  positions.record(220);
  expect(positions.startCommit('B', 220)).toBe(0);
  positions.record(400); // Ignore browser adjustment between render and restoration.
  positions.finishCommit('B'); positions.record(35);
  expect(positions.startCommit('A', 35)).toBe(220);
  positions.finishCommit('A');
  expect(positions.startCommit('B', 220)).toBe(35);
});
it('preserves same-document refresh position and retains saved files across a real empty state', () => {
  const saved = new Map<string, number>();
  const positions = new ReaderPositionMemory(saved);
  positions.finishCommit('A');
  expect(positions.startCommit('A', 187)).toBe(187);
  positions.finishCommit('A'); positions.clear(200); positions.record(0);
  expect(positions.identity).toBe('');
  const remounted = new ReaderPositionMemory(saved);
  expect(remounted.startCommit('A', 0)).toBe(200);
});
