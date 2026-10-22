export type ConfigurationType = 'Application' | 'DynamicLibrary' | 'StaticLibrary' | 'Utility' | 'Makefile' | 'unknown';

/** What a cheap textual scan of a .vcxproj can tell without running MSBuild. */
export interface VcxprojScan {
  /** Keyed by "Configuration|Platform" taken from the PropertyGroup condition. */
  types: Record<string, ConfigurationType>;
  /** From a ConfigurationType in a PropertyGroup without a configuration condition. */
  defaultType?: ConfigurationType;
  sources: number;
  headers: number;
}

const KNOWN_TYPES = new Set<ConfigurationType>(['Application', 'DynamicLibrary', 'StaticLibrary', 'Utility', 'Makefile']);

// The lookbehind skips self-closing <PropertyGroup ... />, which would otherwise run on to the next closing tag.
const PROPERTY_GROUP = /<PropertyGroup\b([^>]*?)(?<!\/)>([\s\S]*?)<\/PropertyGroup>/g;
const CONDITION_ATTR = /\bCondition\s*=\s*"([^"]*)"/;
const CONDITION_VALUE = /==\s*'([^']*)'/;
const CONFIGURATION_TYPE = /<ConfigurationType>\s*([^<\s]+)\s*<\/ConfigurationType>/;

function toType(value: string): ConfigurationType {
  return KNOWN_TYPES.has(value as ConfigurationType) ? (value as ConfigurationType) : 'unknown';
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function scanVcxproj(text: string): VcxprojScan {
  const scan: VcxprojScan = {
    types: {},
    sources: count(text, /<ClCompile\s+Include\s*=/g),
    headers: count(text, /<ClInclude\s+Include\s*=/g),
  };

  for (const group of text.matchAll(PROPERTY_GROUP)) {
    const type = CONFIGURATION_TYPE.exec(group[2]);
    if (!type) continue;
    const condition = CONDITION_ATTR.exec(group[1]);
    if (!condition) {
      scan.defaultType = toType(type[1]);
      continue;
    }
    const config = CONDITION_VALUE.exec(condition[1]);
    if (config) scan.types[config[1]] = toType(type[1]);
  }
  return scan;
}

export function typeFor(scan: VcxprojScan | undefined, projectConfig: string): ConfigurationType {
  if (!scan) return 'unknown';
  return scan.types[projectConfig] ?? scan.defaultType ?? 'unknown';
}
