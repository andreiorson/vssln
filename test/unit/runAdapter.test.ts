import { expect, test } from 'vitest';
import { DapMessage, RunChild, RunConfig, RunDeps, RunSession } from '../../src/debug/runAdapter';

function fakeChild(pid = 7) {
  const cb = { out: (_: string) => {}, err: (_: string) => {}, exit: (_: number | null) => {}, error: (_: string) => {} };
  const child: RunChild & { emitOut(s: string): void; emitErr(s: string): void; exit(code: number | null): void; fail(m: string): void } = {
    pid,
    onStdout: f => (cb.out = f),
    onStderr: f => (cb.err = f),
    onExit: f => (cb.exit = f),
    onError: f => (cb.error = f),
    emitOut: s => cb.out(s),
    emitErr: s => cb.err(s),
    exit: c => cb.exit(c),
    fail: m => cb.error(m),
  };
  return child;
}

function setup(config: Partial<RunConfig> = {}) {
  const sent: DapMessage[] = [];
  const spawned: { program: string; args: string[]; cwd: string; env: Record<string, string | undefined>; newConsole: boolean }[] = [];
  const killed: number[] = [];
  const child = fakeChild();
  const deps: RunDeps = {
    spawn: (program, args, opts) => {
      spawned.push({ program, args, ...opts });
      return child;
    },
    killTree: pid => killed.push(pid),
    processEnv: { Path: 'C:\\bin', KEEP: 'k' },
    send: m => sent.push(m),
  };
  const session = new RunSession({
    program: 'C:\\out\\Tool.exe', args: ['', 'a "b"', 'x y'], cwd: 'C:\\work',
    environment: [{ name: 'PATH', value: 'C:\\tools;C:\\bin' }, { name: 'MODE', value: 'test' }], console: 'internalConsole', ...config,
  }, deps);
  let seq = 1;
  const request = (command: string, args: object = {}) => session.handle({ seq: seq++, type: 'request', command, arguments: args });
  return { sent, spawned, killed, child, session, request };
}

const events = (sent: DapMessage[]) => sent.filter(m => m.type === 'event').map(m => (m as { event: string }).event);
const response = (sent: DapMessage[], command: string) => sent.find(m => m.type === 'response' && (m as { command: string }).command === command) as { success: boolean; message?: string; body?: unknown } | undefined;

test('initialize answers and announces initialized', () => {
  const { sent, request } = setup();
  request('initialize');
  expect(response(sent, 'initialize')!.success).toBe(true);
  expect(events(sent)).toEqual(['initialized']);
});

test('launch starts the program without a shell, with arguments as given and the merged environment', () => {
  const { spawned, sent, request } = setup();
  request('launch');
  expect(spawned).toEqual([{ program: 'C:\\out\\Tool.exe', args: ['', 'a "b"', 'x y'], cwd: 'C:\\work', env: { Path: 'C:\\tools;C:\\bin', KEEP: 'k', MODE: 'test' }, newConsole: false }]);
  expect(response(sent, 'launch')!.success).toBe(true);
});

test('program output goes to the Debug Console, the exit ends the session', () => {
  const { sent, child, request } = setup();
  request('launch');
  child.emitOut('hello\n');
  child.emitErr('oops\n');
  child.exit(3);
  const outputs = sent.filter(m => m.type === 'event' && (m as { event: string }).event === 'output').map(m => (m as { body: { category: string; output: string } }).body);
  expect(outputs).toEqual([
    { category: 'stdout', output: 'hello\n' },
    { category: 'stderr', output: 'oops\n' },
    { category: 'console', output: 'C:\\out\\Tool.exe exited with code 3.\n' },
  ]);
  expect(events(sent).slice(-2)).toEqual(['exited', 'terminated']);
});

test('stopping kills the whole process tree', () => {
  const { killed, sent, request } = setup();
  request('launch');
  request('disconnect');
  expect(killed).toEqual([7]);
  expect(response(sent, 'disconnect')!.success).toBe(true);
});

test('a program that cannot start fails the launch with the reason', () => {
  const { sent, child, request } = setup();
  request('launch');
  child.fail('spawn C:\\out\\Tool.exe ENOENT');
  expect(sent.filter(m => m.type === 'event' && (m as { event: string }).event === 'output').map(m => (m as { body: { output: string } }).body.output))
    .toContain('C:\\out\\Tool.exe could not start: spawn C:\\out\\Tool.exe ENOENT\n');
  expect(events(sent)).toContain('terminated');
});

test('newExternalWindow starts the program in its own console', () => {
  const { spawned, request } = setup({ console: 'newExternalWindow' });
  request('launch');
  expect(spawned[0].newConsole).toBe(true);
});

test('a terminal console asks VS Code to run it in a terminal and ends the session when started', () => {
  const { sent, spawned, session, request } = setup({ console: 'integratedTerminal' });
  request('launch');
  expect(spawned).toEqual([]);
  const ask = sent.find(m => m.type === 'request') as { seq: number; command: string; arguments: { kind: string; cwd: string; args: string[]; env: Record<string, string> } };
  expect(ask.command).toBe('runInTerminal');
  expect(ask.arguments).toEqual({ kind: 'integrated', title: 'Tool.exe', cwd: 'C:\\work', args: ['C:\\out\\Tool.exe', '', 'a "b"', 'x y'], env: { PATH: 'C:\\tools;C:\\bin', MODE: 'test' } });
  session.handle({ seq: 99, type: 'response', request_seq: ask.seq, command: 'runInTerminal', success: true });
  expect(events(sent)).toContain('terminated');
});

test('externalTerminal uses an external terminal', () => {
  const { sent, request } = setup({ console: 'externalTerminal' });
  request('launch');
  expect((sent.find(m => m.type === 'request') as { arguments: { kind: string } }).arguments.kind).toBe('external');
});

test('unknown requests are answered', () => {
  const { sent, request } = setup();
  request('threads');
  expect(response(sent, 'threads')).toMatchObject({ success: true, body: { threads: [] } });
});
