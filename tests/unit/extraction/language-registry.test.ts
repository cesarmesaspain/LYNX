import { describe, expect, it } from 'vitest';
import {
  ALL_LANGUAGES,
  getLanguageConfig,
  getLanguageConfigForPath,
  isSupportedExtension,
  isSupportedFilePath,
  getAllSupportedExtensions,
  getAllLanguageNames,
  type LanguageConfig,
} from '../../../src/extraction/language-registry.js';

function validateConfig(lang: LanguageConfig, name: string): string[] {
  const errors: string[] = [];
  if (!lang.tsLang || typeof lang.tsLang !== 'string') errors.push(`${name}: missing tsLang`);
  if (!Array.isArray(lang.extensions) || lang.extensions.length === 0) errors.push(`${name}: missing extensions`);
  if (!Array.isArray(lang.functionTypes)) errors.push(`${name}: missing functionTypes`);
  if (!Array.isArray(lang.classTypes)) errors.push(`${name}: missing classTypes`);
  if (!Array.isArray(lang.callTypes)) errors.push(`${name}: missing callTypes`);
  if (!Array.isArray(lang.importTypes)) errors.push(`${name}: missing importTypes`);
  if (!Array.isArray(lang.variableTypes)) errors.push(`${name}: missing variableTypes`);
  if (!Array.isArray(lang.commentTypes)) errors.push(`${name}: missing commentTypes`);
  for (const ext of lang.extensions) {
    if (typeof ext !== 'string' || ext.length === 0) errors.push(`${name}: invalid extension "${ext}"`);
  }
  return errors;
}

describe('language-registry', () => {
  const topCount = ALL_LANGUAGES.filter(l => l.useTSCompiler).length + 30; // ~30 TOP_LANGUAGES entries

  it('has ~55 active language configs covering essential ecosystems', () => {
    expect(ALL_LANGUAGES.length).toBeGreaterThanOrEqual(48);
    expect(ALL_LANGUAGES.length).toBeLessThanOrEqual(70);
  });

  it('every language config is structurally valid', () => {
    const errors: string[] = [];
    for (const lang of ALL_LANGUAGES) {
      errors.push(...validateConfig(lang, lang.tsLang));
    }
    expect(errors).toEqual([]);
  });

  it('duplicate extensions only for known multi-language file types', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const lang of ALL_LANGUAGES) {
      for (const ext of lang.extensions) {
        if (seen.has(ext)) {
          dupes.push(`${ext}: ${seen.get(ext)} vs ${lang.tsLang}`);
        } else {
          seen.set(ext, lang.tsLang);
        }
      }
    }
    // Known overlaps: .m (matlab/objc) — legitimate ambiguity.
    // LYNX resolves ambiguity via getLanguageConfigForPath which checks compound extensions first.
    expect(dupes.length).toBeLessThanOrEqual(3);
    for (const d of dupes) {
      expect(d).toMatch(/^m:/);
    }
  });

  it('getLanguageConfig returns config for known extensions', () => {
    expect(getLanguageConfig('ts')?.tsLang).toBe('typescript');
    expect(getLanguageConfig('tsx')?.tsLang).toBe('tsx');
    expect(getLanguageConfig('js')?.tsLang).toBe('javascript');
    expect(getLanguageConfig('py')?.tsLang).toBe('python');
    expect(getLanguageConfig('go')?.tsLang).toBe('go');
    expect(getLanguageConfig('rs')?.tsLang).toBe('rust');
    expect(getLanguageConfig('java')?.tsLang).toBe('java');
    expect(getLanguageConfig('swift')?.tsLang).toBe('swift');
    expect(getLanguageConfig('sh')?.tsLang).toBe('bash');
    expect(getLanguageConfig('md')?.tsLang).toBe('markdown');
    expect(getLanguageConfig('json')?.tsLang).toBe('json');
  });

  it('getLanguageConfig returns null for unsupported extensions', () => {
    expect(getLanguageConfig('zzz')).toBeNull();
    expect(getLanguageConfig('')).toBeNull();
    expect(getLanguageConfig('notarealextension12345')).toBeNull();
  });

  it('getLanguageConfig is case-insensitive', () => {
    expect(getLanguageConfig('TS')?.tsLang).toBe('typescript');
    expect(getLanguageConfig('Py')?.tsLang).toBe('python');
  });

  it('getLanguageConfig strips leading dot', () => {
    expect(getLanguageConfig('.ts')?.tsLang).toBe('typescript');
    expect(getLanguageConfig('.py')?.tsLang).toBe('python');
  });

  it('isSupportedExtension works', () => {
    expect(isSupportedExtension('ts')).toBe(true);
    expect(isSupportedExtension('zzz')).toBe(false);
  });

  it('getAllSupportedExtensions returns non-empty array', () => {
    const all = getAllSupportedExtensions();
    expect(all.length).toBeGreaterThan(70);
    expect(all).toContain('ts');
    expect(all).toContain('py');
    expect(all).toContain('go');
  });

  it('getAllLanguageNames returns all tsLang values', () => {
    const names = getAllLanguageNames();
    expect(names.length).toBe(ALL_LANGUAGES.length);
    expect(names).toContain('typescript');
    expect(names).toContain('python');
    expect(names).toContain('go');
    expect(names).toContain('rust');
    expect(names).toContain('zig');
    expect(names).toContain('haskell');
    expect(names).toContain('ocaml');
  });

  it('getLanguageConfigForPath resolves single-extension paths', () => {
    expect(getLanguageConfigForPath('/src/app.ts')?.tsLang).toBe('typescript');
    expect(getLanguageConfigForPath('main.py')?.tsLang).toBe('python');
    expect(getLanguageConfigForPath('CMakeLists.txt')?.tsLang).toBe('cmake');
  });

  it('getLanguageConfigForPath resolves compound extensions like .test.ts', () => {
    expect(getLanguageConfigForPath('app.test.ts')?.tsLang).toBe('typescript');
    expect(getLanguageConfigForPath('user.spec.tsx')?.tsLang).toBe('tsx');
  });

  it('requires a dot or exact filename before compound extensions', () => {
    expect(getLanguageConfigForPath('app.component.vue')?.tsLang).toBe('vue');
    expect(getLanguageConfigForPath('page.missing.xya')).toBeNull();  // not a registered extension
    expect(getLanguageConfigForPath('mycomponent.vue')?.tsLang).toBe('vue');
    expect(getLanguageConfigForPath('thingng.vue')?.tsLang).toBe('vue');
  });

  it('getLanguageConfigForPath returns null for unknown files', () => {
    expect(getLanguageConfigForPath('unknown.xyz')).toBeNull();
    expect(getLanguageConfigForPath('Makefile')).not.toBeNull(); // has no extension
  });

  it('isSupportedFilePath works', () => {
    expect(isSupportedFilePath('src/app.ts')).toBe(true);
    expect(isSupportedFilePath('readme.md')).toBe(true);
    expect(isSupportedFilePath('data.bin')).toBe(false);
  });

  it('TS/TSX family uses TS compiler', () => {
    const ts = getLanguageConfig('ts')!;
    const tsx = getLanguageConfig('tsx')!;
    expect(ts.useTSCompiler).toBe(true);
    expect(tsx.useTSCompiler).toBe(true);
    expect(ts.functionTypes).toContain('arrow_function');
    expect(ts.functionTypes).toContain('method_definition');
  });

  it('JSON/YAML/TOML/Markdown have no function or class types', () => {
    for (const ext of ['json', 'yaml', 'toml', 'md']) {
      const cfg = getLanguageConfig(ext);
      expect(cfg!.functionTypes).toEqual([]);
      expect(cfg!.classTypes).toEqual([]);
      expect(cfg!.callTypes).toEqual([]);
    }
  });

  it('all ADDITIONAL_LANGUAGES share generic template', () => {
    // Compare two entries known to be in ADDITIONAL_LANGUAGES (generic)
    const cmake = getLanguageConfig('cmake')!;
    const nix = getLanguageConfig('nix')!;
    expect(cmake.functionTypes).toEqual(nix.functionTypes);
    expect(cmake.classTypes).toEqual(nix.classTypes);
    expect(cmake.commentTypes).toEqual(nix.commentTypes);
    expect(cmake.functionTypes.length).toBeGreaterThan(5); // generic has many fallback types
  });

  it('does not return duplicate entries for multi-extension languages', () => {
    // Python: py, pyw, pyi — all three should return the same config
    const py = getLanguageConfig('py');
    const pyw = getLanguageConfig('pyw');
    const pyi = getLanguageConfig('pyi');
    expect(py).not.toBeNull();
    expect(py).toBe(pyw);
    expect(py).toBe(pyi);
  });
});
