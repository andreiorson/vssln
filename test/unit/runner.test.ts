import { expect, test } from 'vitest';
import { BuildRunner, ChildProcessLike, lineSplitter, Spawn } from '../../src/build/runner';

/** A fake process the test drives by hand. */
function fakeProcess(pid = 42) {
  let lineCb: (line: string) => void = () => {};
  let exitCb: (code: number | null) => void = () => {};
  const proc: ChildProcessLike & { emit(line: string): void; exit(code: number | null): void } = {
    pid,
    onLine: cb => (lineCb = cb),
    onExit: cb => (exitCb = cb),
    emit: line => lineCb(line),
    exit: code => exitCb(code),
  };
  return proc;
}

function setup() {
  const proc = fakeProcess();
  const spawned: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const killed: number[] = [];
  const spawn: Spawn = (file, args, env) => {
    spawned.push({ file, args, env });
    return proc;
  };
  const runner = new BuildRunner(spawn, async pid => {
    killed.push(pid);
    proc.exit(1);
  });
  return { proc, spawned, killed, runner };
}

test('forwards lines in order and returns the exit code', async () => {
  const { proc, spawned, runner } = setup();
  const lines: string[] = [];
  const done = runner.run('msbuild.exe', ['a.sln'], { X: '1' }, l => lines.push(l));
  expect(runner.running).toBe(true);
  proc.emit('one');
  proc.emit('two');
  proc.exit(0);
  expect(await done).toEqual({ exitCode: 0, cancelled: false });
  expect(lines).toEqual(['one', 'two']);
  expect(runner.running).toBe(false);
  expect(spawned).toEqual([{ file: 'msbuild.exe', args: ['a.sln'], env: { X: '1' } }]);
});

test('stop kills the process tree and reports cancellation', async () => {
  const { runner, killed } = setup();
  const done = runner.run('msbuild.exe', [], {}, () => {});
  await runner.stop();
  expect(killed).toEqual([42]);
  expect(await done).toEqual({ exitCode: 1, cancelled: true });
});

test('stop while idle does nothing', async () => {
  const { runner, killed } = setup();
  await runner.stop();
  expect(killed).toEqual([]);
});

test('a second run while running is refused', async () => {
  const { proc, runner } = setup();
  const done = runner.run('msbuild.exe', [], {}, () => {});
  await expect(runner.run('msbuild.exe', [], {}, () => {})).rejects.toThrow('A build is already running.');
  proc.exit(0);
  await done;
});

test('the line splitter joins chunks and handles CRLF', () => {
  const lines: string[] = [];
  const split = lineSplitter(l => lines.push(l));
  split.push('first li');
  split.push('ne\r\nsecond\r');
  split.push('\nthird');
  split.end();
  expect(lines).toEqual(['first line', 'second', 'third']);
});
