import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { coalesce, debounce } from '../../src/ui/coalesce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('coalesce runs once per burst, delay counted from the first call', () => {
  const fn = vi.fn();
  const run = coalesce(fn, 50);
  run();
  vi.advanceTimersByTime(30);
  run();
  vi.advanceTimersByTime(20);
  expect(fn).toHaveBeenCalledTimes(1);
  run();
  vi.advanceTimersByTime(50);
  expect(fn).toHaveBeenCalledTimes(2);
});

test('debounce runs once, delay counted from the last call', () => {
  const fn = vi.fn();
  const run = debounce(fn, 300);
  run();
  vi.advanceTimersByTime(200);
  run();
  vi.advanceTimersByTime(200);
  expect(fn).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(fn).toHaveBeenCalledTimes(1);
});
