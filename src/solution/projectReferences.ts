import * as path from 'path';
import { parseXml, XmlElement } from '../util/xml';

export interface ReferenceFs {
  /** The text of a file; undefined when it does not exist or cannot be read. */
  readText(path: string): Promise<string | undefined>;
  /** Whether a file or a folder exists. */
  exists(path: string): Promise<boolean>;
  /** The root element of an XML file, when the reader keeps parsed files (see cachedFs). */
  readXml?(path: string): Promise<XmlElement | undefined>;
  /** What exists() answered for this path before, without waiting; undefined when it was not asked yet. */
  knownExists?(path: string): boolean | undefined;
}

export interface ReferenceContext {
  projectPath: string;
  solutionPath: string;
  /** The project configuration and platform the solution configuration builds. */
  configuration: string;
  platform: string;
  /** Global properties of the build (msbuild.properties), beside Configuration, Platform and the Solution* ones. */
  properties?: Record<string, string>;
  /** The environment of the build: MSBuild starts with its variables as properties. */
  env: Record<string, string | undefined>;
}

export interface ProjectReference {
  /** The Include as written. */
  include: string;
  /** The absolute path, when the Include could be evaluated without MSBuild. */
  path?: string;
  /** The Project metadata (the referenced project's guid), when given. */
  guid?: string;
}

/** Memoizes reads, so the sheets every project imports are read and parsed once per build. */
export function cachedFs(fs: ReferenceFs): ReferenceFs {
  const texts = new Map<string, Promise<string | undefined>>();
  const exists = new Map<string, Promise<boolean>>();
  const answered = new Map<string, boolean>();
  const xml = new Map<string, Promise<XmlElement | undefined>>();
  const memo = <T>(cache: Map<string, Promise<T>>, p: string, read: () => Promise<T>) => {
    const k = p.toLowerCase();
    if (!cache.has(k)) cache.set(k, read());
    return cache.get(k)!;
  };
  return {
    readText: p => memo(texts, p, () => fs.readText(p)),
    exists: p =>
      memo(exists, p, async () => {
        const result = await fs.exists(p);
        answered.set(p.toLowerCase(), result);
        return result;
      }),
    knownExists: p => answered.get(p.toLowerCase()),
    readXml: p =>
      memo(xml, p, async () => {
        const text = await memo(texts, p, () => fs.readText(p));
        return text === undefined ? undefined : parseXml(text);
      }),
  };
}

/**
 * The ProjectReference items of a project as MSBuild would evaluate them for a configuration, read from the text of
 * the project and of the sheets it imports (Directory.Build.props included): properties in document order,
 * environment variables and global properties, conditions with Exists and comparisons, Choose, and the property
 * functions that find sheets above a folder. Sheets that need MSBuild to be found (the Visual C++ ones under
 * $(VCTargetsPath)) are not read; a condition that cannot be decided counts as true.
 */
export async function readProjectReferences(ctx: ReferenceContext, fs: ReferenceFs): Promise<ProjectReference[]> {
  const evaluation = new Evaluation(ctx, fs);
  await evaluation.walkFile(ctx.projectPath);
  return evaluation.references();
}

const lname = (e: XmlElement) => e.name.toLowerCase();
const withSlash = (dir: string) => (dir === '' || /[\\/]$/.test(dir) ? dir : `${dir}\\`);
const unescape = (s: string) => s.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
/** Path.Combine: a rooted part starts over. */
const combine = (parts: string[]) => parts.reduce((acc, p) => (path.win32.isAbsolute(p) || acc === '' ? p : `${withSlash(acc)}${p}`), '');
const splitList = (value: string) => value.split(';').map(s => unescape(s.trim())).filter(Boolean);

/** The index after the parenthesis that closes the one at `open`, skipping quoted text; -1 when unclosed. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i + 1;
    }
  }
  return -1;
}

/** Splits at top-level commas, outside quotes and parentheses. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return args.map(a => a.trim());
}

/**
 * Thrown by the synchronous evaluation when it needs to know whether files exist; the caller asks the file system
 * and evaluates the same step again. Most steps need no file, so they run without waiting.
 */
class NeedFs {
  constructor(readonly paths: string[]) {}
}

type Tri = boolean | undefined;

interface Pending {
  element: XmlElement;
  groupCondition?: string;
  file: string;
}

class Evaluation {
  /** Property values by lower-case name; null: a value that needs MSBuild. */
  private readonly props = new Map<string, string | null>();
  private readonly globals = new Set<string>();
  /** Files read so far: MSBuild imports a file once. */
  private readonly imported = new Set<string>();
  private readonly pending: Pending[] = [];
  private readonly directoryBuild = new Set<string>();
  private readonly existing = new Map<string, boolean>();
  private readonly projectDir: string;

  constructor(private readonly ctx: ReferenceContext, private readonly fs: ReferenceFs) {
    this.projectDir = path.win32.dirname(ctx.projectPath);
    for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) this.props.set(k.toLowerCase(), v);
    const project = path.win32.parse(ctx.projectPath);
    const solution = path.win32.parse(ctx.solutionPath);
    // Visual C++ defines these early; a project may still set them.
    const defaults: Record<string, string> = {
      ProjectDir: withSlash(this.projectDir),
      ProjectName: project.name,
      ProjectPath: ctx.projectPath,
      ProjectFileName: project.base,
      ProjectExt: project.ext,
    };
    for (const [k, v] of Object.entries(defaults)) this.props.set(k.toLowerCase(), v);
    const globals: Record<string, string> = {
      ...ctx.properties,
      Configuration: ctx.configuration,
      Platform: ctx.platform,
      SolutionDir: withSlash(solution.dir),
      SolutionPath: ctx.solutionPath,
      SolutionName: solution.name,
      SolutionFileName: solution.base,
      SolutionExt: solution.ext,
      MSBuildProjectDirectory: this.projectDir,
      MSBuildProjectDirectoryNoRoot: this.projectDir.slice(project.root.length),
      MSBuildProjectFullPath: ctx.projectPath,
      MSBuildProjectFile: project.base,
      MSBuildProjectName: project.name,
      MSBuildProjectExtension: project.ext,
    };
    for (const [k, v] of Object.entries(globals)) {
      this.props.set(k.toLowerCase(), v);
      this.globals.add(k.toLowerCase());
    }
  }

  /** Runs a step; when it needs to know which files exist, asks and runs it again. Synchronous when it needs none. */
  private settle<T>(step: () => T): T | Promise<T> {
    try {
      return step();
    } catch (e) {
      if (!(e instanceof NeedFs)) throw e;
      return Promise.all(e.paths.map(async p => this.existing.set(p.toLowerCase(), await this.fs.exists(p)))).then(() => this.settle(step));
    }
  }

  private existsNow(p: string): boolean {
    const k = p.toLowerCase();
    const known = this.existing.get(k) ?? this.fs.knownExists?.(p);
    if (known === undefined) throw new NeedFs([p]);
    return known;
  }

  async walkFile(file: string): Promise<void> {
    const key = file.toLowerCase();
    if (this.imported.has(key)) return;
    this.imported.add(key);
    const root = this.fs.readXml ? await this.fs.readXml(file) : await this.fs.readText(file).then(t => (t === undefined ? undefined : parseXml(t)));
    if (root && lname(root) === 'project') await this.walk(root.children, file);
  }

  private async walk(children: XmlElement[], file: string): Promise<void> {
    for (const e of children) {
      switch (lname(e)) {
        case 'propertygroup': {
          const holds = this.settle(() => this.holds(e, file));
          if (!(holds instanceof Promise ? await holds : holds)) break;
          for (const p of e.children) {
            const done = this.settle(() => this.setProperty(p, file));
            if (done instanceof Promise) await done;
          }
          break;
        }
        case 'itemgroup':
          for (const item of e.children) {
            if (lname(item) === 'projectreference') this.pending.push({ element: item, groupCondition: e.attributes.Condition, file });
          }
          break;
        case 'import':
          await this.importElement(e, file);
          break;
        case 'importgroup':
          if (!(await this.settle(() => this.holds(e, file)))) break;
          for (const i of e.children) if (lname(i) === 'import') await this.importElement(i, file);
          break;
        case 'choose':
          for (const branch of e.children) {
            const name = lname(branch);
            if (name === 'otherwise' || (name === 'when' && (await this.settle(() => this.holds(branch, file))))) {
              await this.walk(branch.children, file);
              break;
            }
          }
          break;
      }
    }
  }

  private setProperty(p: XmlElement, file: string): void {
    const name = p.name.toLowerCase();
    if (this.globals.has(name) || !this.holds(p, file)) return;
    const value = this.expand(p.text.trim(), file);
    this.props.set(name, value ?? null);
  }

  private async importElement(e: XmlElement, file: string): Promise<void> {
    if (e.attributes.Sdk !== undefined) return;
    const parts = await this.settle(() => {
      if (!this.holds(e, file)) return [];
      const project = this.expand(e.attributes.Project ?? '', file);
      return project === undefined ? [] : splitList(project);
    });
    for (const part of parts) {
      const base = path.win32.basename(part).toLowerCase();
      // Visual C++ imports Directory.Build.props and .targets from these; they cannot be read without MSBuild.
      if (base === 'microsoft.cpp.default.props') await this.importDirectoryBuild('props');
      else if (base === 'microsoft.cpp.targets') await this.importDirectoryBuild('targets');
      else if (!/[*?]/.test(part)) await this.walkFile(path.win32.resolve(path.win32.dirname(file), part));
    }
  }

  private async importDirectoryBuild(kind: 'props' | 'targets'): Promise<void> {
    if (this.directoryBuild.has(kind)) return;
    this.directoryBuild.add(kind);
    const suffix = kind === 'props' ? 'Props' : 'Targets';
    const found = await this.settle(() => {
      if (this.lookup(`ImportDirectoryBuild${suffix}`)?.toLowerCase() === 'false') return '';
      return this.lookup(`DirectoryBuild${suffix}Path`) || this.fileAbove(this.projectDir, `Directory.Build.${kind}`);
    });
    if (found) await this.walkFile(path.win32.resolve(this.projectDir, found));
  }

  /** The path of a file in this folder or the nearest one above it; '' when there is none. */
  private fileAbove(start: string, fileName: string): string {
    const candidates: string[] = [];
    for (let dir = path.win32.resolve(this.projectDir, start); ; dir = path.win32.dirname(dir)) {
      candidates.push(path.win32.join(dir, fileName));
      if (path.win32.dirname(dir) === dir) break;
    }
    const unknown: string[] = [];
    for (const c of candidates) {
      try {
        if (this.existsNow(c) && unknown.length === 0) return c;
      } catch (e) {
        if (!(e instanceof NeedFs)) throw e;
        unknown.push(c);
      }
    }
    if (unknown.length > 0) throw new NeedFs(unknown);
    return '';
  }

  /** A property's value: '' when undefined (as in MSBuild), undefined when it needs MSBuild. */
  private lookup(name: string, file?: string): string | undefined {
    const n = name.toLowerCase();
    if (file && n.startsWith('msbuildthisfile')) {
      const f = path.win32.parse(file);
      const reserved: Record<string, string> = {
        msbuildthisfile: f.base,
        msbuildthisfiledirectory: withSlash(f.dir),
        msbuildthisfiledirectorynoroot: withSlash(f.dir.slice(f.root.length)),
        msbuildthisfilefullpath: file,
        msbuildthisfilename: f.name,
        msbuildthisfileextension: f.ext,
      };
      if (n in reserved) return reserved[n];
    }
    const value = this.props.get(n);
    return value === null ? undefined : (value ?? '');
  }

  /** Expands $(...) in a value; undefined when it needs MSBuild (item lists, metadata, other property functions). */
  expand(text: string, file: string): string | undefined {
    if (!text.includes('(')) return text;
    if (/[@%]\(/.test(text)) return undefined;
    let out = '';
    let i = 0;
    for (;;) {
      const at = text.indexOf('$(', i);
      if (at < 0) return out + text.slice(i);
      const end = closing(text, at + 1);
      if (end < 0) return undefined;
      const value = this.property(text.slice(at + 2, end - 1), file);
      if (value === undefined) return undefined;
      out += text.slice(i, at) + value;
      i = end;
    }
  }

  private property(inner: string, file: string): string | undefined {
    const simple = /^\s*([A-Za-z_][\w-]*)\s*$/.exec(inner);
    if (simple) return this.lookup(simple[1], file);
    const call = /^\s*\[([^\]]+)\]::(\w+)\s*\(([\s\S]*)\)\s*$/.exec(inner);
    if (!call) return undefined;
    const args: string[] = [];
    if (call[3].trim() !== '') {
      for (const raw of splitArgs(call[3])) {
        const quoted = /^(['"`])([\s\S]*)\1$/.exec(raw);
        const value = this.expand(quoted ? quoted[2] : raw, file);
        if (value === undefined) return undefined;
        args.push(value);
      }
    }
    const fn = `${call[1].trim().toLowerCase()}::${call[2].toLowerCase()}`;
    switch (fn) {
      case 'msbuild::getdirectorynameoffileabove': {
        if (args.length !== 2) return undefined;
        const found = this.fileAbove(args[0], args[1]);
        return found && path.win32.dirname(found);
      }
      case 'msbuild::getpathoffileabove':
        if (args.length < 1 || args.length > 2) return undefined;
        return this.fileAbove(args[1] || path.win32.dirname(file), args[0]);
      case 'msbuild::normalizedirectory':
        return withSlash(path.win32.resolve(this.projectDir, combine(args)));
      case 'msbuild::normalizepath':
        return path.win32.resolve(this.projectDir, combine(args));
      case 'msbuild::ensuretrailingslash':
        return args.length === 1 ? withSlash(args[0]) : undefined;
      case 'system.io.path::combine':
        return combine(args);
      case 'system.io.path::getfullpath':
        return args.length === 1 ? path.win32.resolve(this.projectDir, args[0]) : undefined;
      case 'system.io.path::getdirectoryname':
        return args.length === 1 ? path.win32.dirname(args[0]) : undefined;
      case 'system.io.path::getfilename':
        return args.length === 1 ? path.win32.basename(args[0]) : undefined;
      case 'system.environment::getenvironmentvariable': {
        if (args.length !== 1) return undefined;
        const key = Object.keys(this.ctx.env).find(k => k.toLowerCase() === args[0].toLowerCase());
        return key === undefined ? '' : (this.ctx.env[key] ?? '');
      }
      default:
        return undefined;
    }
  }

  /** Whether an element's Condition holds; one that cannot be decided counts as true. */
  private holds(e: XmlElement, file: string): boolean {
    return this.condition(e.attributes.Condition, file) !== false;
  }

  private condition(condition: string | undefined, file: string): Tri {
    if (condition === undefined || condition.trim() === '') return true;
    const tokens = tokenize(condition);
    if (!tokens) return undefined;
    const parser = new ConditionParser(tokens, this, path.win32.dirname(file), file);
    try {
      const result = parser.or();
      return parser.done() ? result : undefined;
    } catch (e) {
      if (e instanceof NeedFs) throw e;
      return undefined;
    }
  }

  exists(p: string, dir: string): boolean {
    const clean = unescape(p.trim());
    return clean !== '' && this.existsNow(path.win32.resolve(dir, clean));
  }

  /** The references, in the order MSBuild adds them: after all properties, with their final values. */
  async references(): Promise<ProjectReference[]> {
    const result: ProjectReference[] = [];
    for (const item of this.pending) await this.settle(() => this.addReference(item, result));
    return result;
  }

  private addReference({ element, groupCondition, file }: Pending, result: ProjectReference[]): void {
    if (this.condition(groupCondition, file) === false || !this.holds(element, file)) return;
    const same = (r: ProjectReference, p: string | undefined, include: string) =>
      p !== undefined && r.path !== undefined ? r.path.toLowerCase() === p.toLowerCase() : r.include.toLowerCase() === include.toLowerCase();
    const remove = element.attributes.Remove;
    const include = element.attributes.Include;
    if (remove !== undefined) {
      const expanded = this.expand(remove, file);
      for (const part of expanded === undefined ? [] : splitList(expanded)) {
        const p = /[*?]/.test(part) ? undefined : path.win32.resolve(this.projectDir, part);
        for (let i = result.length - 1; i >= 0; i--) if (same(result[i], p, part)) result.splice(i, 1);
      }
      return;
    }
    if (include === undefined) return;
    const guid = element.children.find(c => lname(c) === 'project')?.text.trim();
    const add = (r: ProjectReference) => {
      if (!result.some(x => same(x, r.path, r.include))) result.push(guid ? { ...r, guid } : r);
    };
    const expanded = this.expand(include, file);
    if (expanded === undefined) {
      add({ include });
      return;
    }
    for (const part of splitList(expanded)) {
      const written = include.includes(';') ? part : include;
      add(/[*?]/.test(part) ? { include: written } : { include: written, path: path.win32.resolve(this.projectDir, part) });
    }
  }
}

type Token = { kind: 'op'; value: string } | { kind: 'string'; value: string } | { kind: 'word'; value: string };

/** Conditions repeat across the sheets every project imports: each is split once. */
const tokenCache = new Map<string, Token[] | undefined>();

/** Tokens of a condition; undefined when it cannot be split. */
function tokenize(text: string): Token[] | undefined {
  if (tokenCache.has(text)) return tokenCache.get(text);
  if (tokenCache.size > 10000) tokenCache.clear();
  const tokens = split(text);
  tokenCache.set(text, tokens);
  return tokens;
}

function split(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return undefined;
      tokens.push({ kind: 'string', value: text.slice(i + 1, end) });
      i = end + 1;
    } else if (/^(==|!=|<=|>=)/.test(text.slice(i, i + 2))) {
      tokens.push({ kind: 'op', value: text.slice(i, i + 2) });
      i += 2;
    } else if ('()!<>,'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s'"()!<>=,]/.test(text[j])) {
        if (/[$@%]/.test(text[j]) && text[j + 1] === '(') {
          const end = closing(text, j + 1);
          if (end < 0) return undefined;
          j = end;
        } else {
          j++;
        }
      }
      if (j === i) return undefined;
      tokens.push({ kind: 'word', value: text.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

/** MSBuild conditions: or, and, !, parentheses, comparisons, Exists and HasTrailingSlash; three-valued. */
class ConditionParser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly evaluation: Evaluation,
    private readonly dir: string,
    private readonly file: string,
  ) {}

  done(): boolean {
    return this.i === this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'op' && t.value === value;
  }

  private isKeyword(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'word' && t.value.toLowerCase() === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new Error(`expected ${value}`);
    this.i++;
  }

  or(): Tri {
    let result = this.and();
    while (this.isKeyword('or')) {
      this.i++;
      const right = this.and();
      result = result === true || right === true ? true : result === false && right === false ? false : undefined;
    }
    return result;
  }

  private and(): Tri {
    let result = this.not();
    while (this.isKeyword('and')) {
      this.i++;
      const right = this.not();
      result = result === false || right === false ? false : result === true && right === true ? true : undefined;
    }
    return result;
  }

  private not(): Tri {
    if (this.isOp('!')) {
      this.i++;
      const inner = this.not();
      return inner === undefined ? undefined : !inner;
    }
    return this.primary();
  }

  private primary(): Tri {
    if (this.isOp('(')) {
      this.i++;
      const inner = this.or();
      this.expect(')');
      return inner;
    }
    const t = this.peek();
    if (t?.kind === 'word' && this.tokens[this.i + 1]?.kind === 'op' && this.tokens[this.i + 1].value === '(') {
      this.i += 2;
      const args: (string | undefined)[] = [];
      while (!this.isOp(')')) {
        args.push(this.operand());
        if (this.isOp(',')) this.i++;
        else if (!this.isOp(')')) throw new Error('expected , or )');
      }
      this.i++;
      const arg = args.length === 1 ? args[0] : undefined;
      if (arg === undefined) return undefined;
      switch (t.value.toLowerCase()) {
        case 'exists':
          return this.evaluation.exists(arg, this.dir);
        case 'hastrailingslash':
          return /[\\/]$/.test(arg);
        default:
          return undefined;
      }
    }
    const left = this.operand();
    const op = this.peek();
    if (op?.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(op.value)) {
      this.i++;
      const right = this.operand();
      if (left === undefined || right === undefined) return undefined;
      if (op.value === '==') return left.toLowerCase() === right.toLowerCase();
      if (op.value === '!=') return left.toLowerCase() !== right.toLowerCase();
      const a = Number(left);
      const b = Number(right);
      if (left.trim() === '' || right.trim() === '' || Number.isNaN(a) || Number.isNaN(b)) return undefined;
      return op.value === '<' ? a < b : op.value === '>' ? a > b : op.value === '<=' ? a <= b : a >= b;
    }
    if (left === undefined) return undefined;
    const lower = left.toLowerCase();
    if (['true', 'on', 'yes'].includes(lower)) return true;
    if (['false', 'off', 'no'].includes(lower)) return false;
    return undefined;
  }

  private operand(): string | undefined {
    const t = this.peek();
    if (!t || t.kind === 'op') throw new Error('expected a value');
    this.i++;
    return this.evaluation.expand(t.value, this.file);
  }
}
