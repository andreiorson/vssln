/** Environment variables as Windows treats them: names are case-insensitive. */

export type Env = Record<string, string | undefined>;

export function envLookup(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Sets a variable, replacing every other spelling of its name; an existing spelling is kept. */
export function setVariable(env: Env, name: string, value: string): void {
  const keys = Object.keys(env).filter(k => k.toLowerCase() === name.toLowerCase());
  const keep = keys[0] ?? name;
  for (const k of keys) if (k !== keep) delete env[k];
  env[keep] = value;
}

/** A copy of `base` with each later map applied on top, without duplicate spellings. */
export function withVariables(base: Env, ...layers: Env[]): Record<string, string> {
  const out: Env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) setVariable(out, k, v);
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) if (v !== undefined) setVariable(out, k, v);
  return out as Record<string, string>;
}
