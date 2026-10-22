import { applyEdits, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser';

export type ConsoleKind = 'integratedTerminal' | 'externalTerminal' | 'internalConsole' | 'newExternalWindow';

export interface DebugSettings {
  program?: string | null;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  console?: ConsoleKind;
}

export interface ProjectSettings {
  debug?: DebugSettings & { byConfiguration?: Record<string, DebugSettings> };
}

/** Contents of the personal .vscode/vssln.json (spec section 5). */
export interface VsslnSettings {
  solution?: string;
  configuration?: string;
  startupProject?: string;
  toolchain?: { vsVersion?: string; msbuildPath?: string | null };
  environment?: Record<string, string>;
  build?: { saveBeforeBuild?: boolean; buildBeforeDebug?: boolean };
  msbuild?: { properties?: Record<string, string>; maxParallelism?: number };
  projects?: Record<string, ProjectSettings>;
}

export type SelectionKey = 'solution' | 'configuration' | 'startupProject';

export interface ParsedSettings {
  settings: VsslnSettings;
  syntaxOk: boolean;
  problems: string[];
}

const CONSOLE_KINDS: ConsoleKind[] = ['integratedTerminal', 'externalTerminal', 'internalConsole', 'newExternalWindow'];

type Json = unknown;
type Obj = Record<string, Json>;

function isObject(v: Json): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads each known key, keeps valid values, and records a problem for every invalid one. */
class Validator {
  readonly problems: string[] = [];

  private fail(where: string, expected: string): void {
    this.problems.push(`vssln.json: "${where}" must be ${expected}.`);
  }

  unknownKeys(obj: Obj, known: string[], prefix: string): void {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) this.problems.push(`vssln.json: unknown setting "${prefix}${key}".`);
    }
  }

  string(obj: Obj, key: string, where: string): string | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v;
    this.fail(where, 'a string');
    return undefined;
  }

  nullableString(obj: Obj, key: string, where: string): string | null | undefined {
    return obj[key] === null ? null : this.string(obj, key, where);
  }

  boolean(obj: Obj, key: string, where: string): boolean | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    this.fail(where, 'true or false');
    return undefined;
  }

  count(obj: Obj, key: string, where: string): number | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
    this.fail(where, 'a whole number, 0 or more');
    return undefined;
  }

  stringArray(obj: Obj, key: string, where: string): string[] | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[];
    this.fail(where, 'a list of strings');
    return undefined;
  }

  object(obj: Obj, key: string, where: string): Obj | undefined {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (isObject(v)) return v;
    this.fail(where, 'an object');
    return undefined;
  }

  stringMap(obj: Obj, key: string, where: string): Record<string, string> | undefined {
    const o = this.object(obj, key, where);
    if (!o) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') out[k] = v;
      else this.fail(`${where}.${k}`, 'a string');
    }
    return out;
  }

  debug(obj: Obj, where: string): DebugSettings {
    const out: DebugSettings = {};
    set(out, 'program', this.nullableString(obj, 'program', `${where}.program`));
    set(out, 'args', this.stringArray(obj, 'args', `${where}.args`));
    set(out, 'cwd', this.string(obj, 'cwd', `${where}.cwd`));
    set(out, 'env', this.stringMap(obj, 'env', `${where}.env`));
    const console = this.string(obj, 'console', `${where}.console`);
    if (console !== undefined) {
      if ((CONSOLE_KINDS as string[]).includes(console)) out.console = console as ConsoleKind;
      else this.fail(`${where}.console`, `one of ${CONSOLE_KINDS.join(', ')}`);
    }
    return out;
  }
}

function set<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function validate(root: Obj, v: Validator): VsslnSettings {
  const s: VsslnSettings = {};
  v.unknownKeys(root, ['solution', 'configuration', 'startupProject', 'toolchain', 'environment', 'build', 'msbuild', 'projects', '$schema'], '');
  set(s, 'solution', v.string(root, 'solution', 'solution'));
  set(s, 'configuration', v.string(root, 'configuration', 'configuration'));
  set(s, 'startupProject', v.string(root, 'startupProject', 'startupProject'));

  const toolchain = v.object(root, 'toolchain', 'toolchain');
  if (toolchain) {
    s.toolchain = {};
    set(s.toolchain, 'vsVersion', v.string(toolchain, 'vsVersion', 'toolchain.vsVersion'));
    set(s.toolchain, 'msbuildPath', v.nullableString(toolchain, 'msbuildPath', 'toolchain.msbuildPath'));
  }

  set(s, 'environment', v.stringMap(root, 'environment', 'environment'));

  const build = v.object(root, 'build', 'build');
  if (build) {
    s.build = {};
    set(s.build, 'saveBeforeBuild', v.boolean(build, 'saveBeforeBuild', 'build.saveBeforeBuild'));
    set(s.build, 'buildBeforeDebug', v.boolean(build, 'buildBeforeDebug', 'build.buildBeforeDebug'));
  }

  const msbuild = v.object(root, 'msbuild', 'msbuild');
  if (msbuild) {
    s.msbuild = {};
    set(s.msbuild, 'properties', v.stringMap(msbuild, 'properties', 'msbuild.properties'));
    set(s.msbuild, 'maxParallelism', v.count(msbuild, 'maxParallelism', 'msbuild.maxParallelism'));
  }

  const projects = v.object(root, 'projects', 'projects');
  if (projects) {
    s.projects = {};
    for (const [name, value] of Object.entries(projects)) {
      const where = `projects.${name}`;
      if (!isObject(value)) {
        v.problems.push(`vssln.json: "${where}" must be an object.`);
        continue;
      }
      const project: ProjectSettings = {};
      const debug = v.object(value, 'debug', `${where}.debug`);
      if (debug) {
        project.debug = v.debug(debug, `${where}.debug`);
        const byConfig = v.object(debug, 'byConfiguration', `${where}.debug.byConfiguration`);
        if (byConfig) {
          project.debug.byConfiguration = {};
          for (const [config, entry] of Object.entries(byConfig)) {
            const at = `${where}.debug.byConfiguration.${config}`;
            if (isObject(entry)) project.debug.byConfiguration[config] = v.debug(entry, at);
            else v.problems.push(`vssln.json: "${at}" must be an object.`);
          }
        }
      }
      s.projects[name] = project;
    }
  }
  return s;
}

/** Line of an error, counted at the last non-blank character before it (where the mistake usually is). */
function lineAt(text: string, offset: number): number {
  let pos = Math.min(offset, text.length);
  while (pos > 0 && /\s/.test(text[pos - 1])) pos--;
  return text.slice(0, pos).split('\n').length;
}

const BOM = '﻿';

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function parseSettings(raw: string): ParsedSettings {
  const text = stripBom(raw);
  if (text.trim() === '') return { settings: {}, syntaxOk: true, problems: [] };

  const errors: ParseError[] = [];
  const root = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    return {
      settings: {},
      syntaxOk: false,
      problems: [`vssln.json: syntax error (${printParseErrorCode(first.error)}) at line ${lineAt(text, first.offset)}.`],
    };
  }
  if (!isObject(root)) {
    return { settings: {}, syntaxOk: false, problems: ['vssln.json: the file must contain a JSON object.'] };
  }
  const v = new Validator();
  return { settings: validate(root, v), syntaxOk: true, problems: v.problems };
}

const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

/** Applies an edit to the text without its BOM (jsonc-parser rejects it) and puts the BOM back. */
function edit(raw: string, change: (base: string) => string): string {
  const bom = raw.startsWith(BOM) ? BOM : '';
  const text = stripBom(raw);
  return bom + change(text.trim() === '' ? '{}' : text);
}

/** Sets one selection key, keeping comments and formatting of the rest of the file. */
export function applySelectionEdit(text: string, key: SelectionKey, value: string): string {
  return edit(text, base => applyEdits(base, modify(base, [key], value, FORMATTING)));
}

/** Adds `"key": {}` at the top level when the key is absent; otherwise returns the text unchanged. */
export function ensureObjectKey(text: string, key: string): string {
  const root: unknown = parse(stripBom(text), [], { allowTrailingComma: true });
  if (isObject(root) && key in root) return text;
  return edit(text, base => applyEdits(base, modify(base, [key], {}, FORMATTING)));
}
