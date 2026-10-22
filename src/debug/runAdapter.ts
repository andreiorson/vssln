import * as path from 'path';
import { Env, withVariables } from '../util/env';

/**
 * "Run without debugging" as a tiny debug adapter (DAP), so VS Code treats it as a session (Stop, Debug Console) while
 * the program runs as a plain child process: no debugger, no shell, arguments passed exactly as given.
 */

export interface RunConfig {
  program: string;
  args: string[];
  cwd: string;
  /** Changes to the inherited environment. */
  environment: { name: string; value: string }[];
  console: string;
}

export interface RunChild {
  pid?: number;
  onStdout(cb: (text: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (message: string) => void): void;
}

export interface RunDeps {
  spawn(program: string, args: string[], opts: { cwd: string; env: Env; newConsole: boolean }): RunChild;
  killTree(pid: number): void;
  processEnv: Env;
  send(message: DapMessage): void;
}

export type DapMessage =
  | { seq: number; type: 'request'; command: string; arguments?: unknown }
  | { seq: number; type: 'response'; request_seq: number; command: string; success: boolean; message?: string; body?: unknown }
  | { seq: number; type: 'event'; event: string; body?: unknown };

export class RunSession {
  private seq = 1;
  private child?: RunChild;
  private ended = false;
  private terminalRequest?: number;

  constructor(private readonly config: RunConfig, private readonly deps: RunDeps) {}

  handle(message: DapMessage): void {
    if (message.type === 'response') {
      if (message.request_seq === this.terminalRequest) {
        if (!message.success) this.output('console', `${this.config.program} could not start in a terminal: ${message.message ?? ''}\n`);
        // The terminal owns the program now; the session has nothing more to watch.
        this.end();
      }
      return;
    }
    if (message.type !== 'request') return;
    switch (message.command) {
      case 'initialize':
        this.respond(message, { supportsConfigurationDoneRequest: true, supportTerminateDebuggee: true });
        this.event('initialized');
        return;
      case 'launch':
        this.respond(message);
        this.start();
        return;
      case 'disconnect':
      case 'terminate':
        if (this.child?.pid !== undefined && !this.ended) this.deps.killTree(this.child.pid);
        this.respond(message);
        this.end();
        return;
      case 'threads':
        this.respond(message, { threads: [] });
        return;
      default:
        this.respond(message);
    }
  }

  private start(): void {
    const { program, args, cwd, environment, console } = this.config;
    const changes: Env = Object.fromEntries(environment.map(e => [e.name, e.value]));
    if (console === 'integratedTerminal' || console === 'externalTerminal') {
      this.terminalRequest = this.seq;
      this.deps.send({
        seq: this.seq++,
        type: 'request',
        command: 'runInTerminal',
        arguments: { kind: console === 'integratedTerminal' ? 'integrated' : 'external', title: path.win32.basename(program), cwd, args: [program, ...args], env: changes },
      });
      return;
    }
    const child = this.deps.spawn(program, args, { cwd, env: withVariables(this.deps.processEnv, changes), newConsole: console === 'newExternalWindow' });
    this.child = child;
    child.onStdout(text => this.output('stdout', text));
    child.onStderr(text => this.output('stderr', text));
    child.onError(message => {
      this.output('console', `${program} could not start: ${message}\n`);
      this.end();
    });
    child.onExit(code => {
      if (this.ended) return;
      this.output('console', `${program} exited with code ${code ?? 'unknown'}.\n`);
      this.event('exited', { exitCode: code ?? 1 });
      this.end();
    });
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.event('terminated');
  }

  private output(category: 'stdout' | 'stderr' | 'console', output: string): void {
    this.event('output', { category, output });
  }

  private event(event: string, body?: unknown): void {
    this.deps.send({ seq: this.seq++, type: 'event', event, ...(body !== undefined ? { body } : {}) });
  }

  private respond(request: { seq: number; command: string }, body?: unknown): void {
    this.deps.send({ seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command, success: true, ...(body !== undefined ? { body } : {}) });
  }
}
