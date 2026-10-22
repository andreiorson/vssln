import { execFile, execFileSync, spawn } from 'child_process';

export interface ChildProcessLike {
  pid?: number;
  onLine(cb: (line: string) => void): void;
  /** The process could not be started or failed outside its own output (for example, no MSBuild.exe). */
  onError(cb: (message: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export type Spawn = (file: string, args: string[], env: Record<string, string | undefined>) => ChildProcessLike;
export type KillTree = (pid: number) => Promise<void>;

/** Splits a stream of text chunks into lines (LF or CRLF); `end` flushes the last unterminated line. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) onLine(part.replace(/\r$/, ''));
    },
    end() {
      if (rest !== '') onLine(rest.replace(/\r$/, ''));
      rest = '';
    },
  };
}

/** Runs one MSBuild process at a time; Stop kills its whole process tree. */
export class BuildRunner {
  private current?: { pid?: number; cancelled: boolean };
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly spawn: Spawn, private readonly kill: KillTree) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  /** Resolves when no process is running (immediately when idle). */
  whenIdle(): Promise<void> {
    return this.idle;
  }

  run(
    file: string,
    args: string[],
    env: Record<string, string | undefined>,
    onLine: (line: string) => void,
    onError: (message: string) => void = () => {},
  ): Promise<{ exitCode: number | null; cancelled: boolean }> {
    if (this.current) return Promise.reject(new Error('A build is already running.'));
    const proc = this.spawn(file, args, env);
    const current = { pid: proc.pid, cancelled: false };
    this.current = current;
    let markIdle = () => {};
    this.idle = new Promise(resolve => (markIdle = resolve));
    return new Promise(resolve => {
      proc.onLine(onLine);
      proc.onError(onError);
      proc.onExit(code => {
        if (this.current === current) this.current = undefined;
        markIdle();
        resolve({ exitCode: code, cancelled: current.cancelled });
      });
    });
  }

  async stop(): Promise<void> {
    const current = this.current;
    if (!current || current.pid === undefined) return;
    current.cancelled = true;
    await this.kill(current.pid);
  }

  /** For extension shutdown: a synchronous kill, so it is done before the extension host exits. */
  stopNow(): void {
    const current = this.current;
    if (!current || current.pid === undefined) return;
    current.cancelled = true;
    try {
      execFileSync('taskkill', ['/pid', String(current.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
}

/** child_process.spawn without a shell; stdout and stderr become one stream of UTF-8 lines. */
export function realSpawn(): Spawn {
  return (file, args, env) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true });
    let lineCb: (line: string) => void = () => {};
    let errorCb: (message: string) => void = () => {};
    let exitCb: (code: number | null) => void = () => {};
    let exited = false;
    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      exitCb(code);
    };
    const out = lineSplitter(l => lineCb(l));
    const err = lineSplitter(l => lineCb(l));
    child.stdout.setEncoding('utf8').on('data', (c: string) => out.push(c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c));
    child.on('error', e => {
      errorCb(e.message);
      exit(null);
    });
    child.on('close', code => {
      out.end();
      err.end();
      exit(code);
    });
    return {
      pid: child.pid,
      onLine: cb => (lineCb = cb),
      onError: cb => (errorCb = cb),
      onExit: cb => (exitCb = cb),
    };
  };
}

/** taskkill /t /f ends MSBuild together with its worker nodes and the compilers they started. */
export function realKillTree(): KillTree {
  return pid =>
    new Promise(resolve => {
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve());
    });
}
