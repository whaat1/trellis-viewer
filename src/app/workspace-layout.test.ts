import { expect, it } from 'vitest';
import { snapTaskHeight } from './layout-sizing';
it('snaps to whole rows including three or more within the available bounds', () => {
  expect(snapTaskHeight(325, 180, 500)).toBe(324);
  expect(snapTaskHeight(500, 180, 500)).toBe(468);
  expect(snapTaskHeight(230, 180, 220)).toBe(180);
  expect(snapTaskHeight(0, 180, 180)).toBe(180);
});
