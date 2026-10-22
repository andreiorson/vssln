import { expect, test } from 'vitest';
import { Scheduler } from '../../src/intellisense/scheduler';

/** Runs that finish when the test says so; records starts, aborts and completions. */
function harness(workers: number) {
  const log: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const scheduler = new Scheduler<string>(
    workers,
    (item, signal) =>
      new Promise<void>((resolve, reject) => {
        log.push(`start ${item}`);
        signal.addEventListener('abort', () => {
          log.push(`abort ${item}`);
          reject(new Error('aborted'));
        });
        pending.set(item, {
          resolve: () => {
            log.push(`done ${item}`);
            resolve();
          },
          reject,
        });
      }),
    item => item,
  );
  const tick = () => new Promise(r => setTimeout(r, 0));
  const finish = async (item: string) => {
    pending.get(item)!.resolve();
    await tick();
  };
  return { scheduler, log, finish, fail: async (item: string) => { pending.get(item)!.reject(new Error('boom')); await tick(); }, tick };
}

test('at most N run at once, in order', async () => {
  const h = harness(2);
  h.scheduler.enqueue(['a', 'b', 'c']);
  await h.tick();
  expect(h.log).toEqual(['start a', 'start b']);
  await h.finish('a');
  expect(h.log).toEqual(['start a', 'start b', 'done a', 'start c']);
});

test('prioritized items run first; an item is queued once', async () => {
  const h = harness(1);
  h.scheduler.enqueue(['a', 'b', 'c', 'd']);
  h.scheduler.enqueue(['c']);
  h.scheduler.prioritize(['d', 'c']);
  await h.tick();
  await h.finish('a');
  await h.finish('d');
  await h.finish('c');
  await h.finish('b');
  expect(h.log.filter(l => l.startsWith('start'))).toEqual(['start a', 'start d', 'start c', 'start b']);
});

test('pause aborts running items and puts them first; nothing starts until resume', async () => {
  const h = harness(2);
  h.scheduler.enqueue(['a', 'b', 'c']);
  await h.tick();
  h.scheduler.pause();
  await h.tick();
  expect(h.log).toEqual(['start a', 'start b', 'abort a', 'abort b']);
  h.scheduler.enqueue(['d']);
  await h.tick();
  expect(h.log.filter(l => l.startsWith('start'))).toHaveLength(2);
  h.scheduler.resume();
  await h.tick();
  expect(h.log.slice(4)).toEqual(['start a', 'start b']);
  await h.finish('a');
  expect(h.log.at(-1)).toBe('start c');
});

test('restart aborts a running item and runs it again first; a queued one moves first', async () => {
  const h = harness(1);
  h.scheduler.enqueue(['a', 'b', 'c']);
  await h.tick();
  h.scheduler.restart(['c', 'a']);
  await h.tick();
  expect(h.log).toEqual(['start a', 'abort a', 'start c']);
  await h.finish('c');
  expect(h.log.at(-1)).toBe('start a');
  await h.finish('a');
  expect(h.log.at(-1)).toBe('start b');
});

test('cancel aborts and drops everything; idle resolves', async () => {
  const h = harness(1);
  h.scheduler.enqueue(['a', 'b']);
  await h.tick();
  const idle = h.scheduler.idle;
  h.scheduler.cancel();
  await idle;
  await h.tick();
  expect(h.log).toEqual(['start a', 'abort a']);
});

test('a failing run does not stop the others; idle resolves when the queue drains', async () => {
  const h = harness(1);
  h.scheduler.enqueue(['a', 'b']);
  await h.tick();
  let idle = false;
  void h.scheduler.idle.then(() => (idle = true));
  await h.fail('a');
  expect(h.log).toEqual(['start a', 'start b']);
  expect(idle).toBe(false);
  await h.finish('b');
  expect(idle).toBe(true);
  // Already idle: resolves at once.
  await h.scheduler.idle;
});
