/*
 * languages.ts — Backward-compatible wrapper around language-registry.ts.
 *
 * Delegates to the language registry. Kept for
 * backward compatibility with code that imports from this module.
 */

import {
  getLanguageConfig,
  getLanguageConfigForPath,
  isSupportedExtension,
  isSupportedFilePath,
  getAllSupportedExtensions,
} from './language-registry.js';
import type { LanguageConfig as TSConfig } from './language-registry.js';

export interface LanguageConfig {
  name: string;
  extensions: string[];
  supportsImports: boolean;
}

/** Map tree-sitter-wasm configs to the legacy LanguageConfig shape. */
function toLegacyConfig(c: TSConfig): LanguageConfig {
  return {
    name: c.tsLang,
    extensions: c.extensions.map((e) => `.${e}`),
    supportsImports: c.hasImports,
  };
}

/** Legacy export kept for compatibility. */
export const LANGUAGE_CONFIGS: LanguageConfig[] = [];

/** Detect language from file path. */
export function detectLanguage(filePath: string): LanguageConfig | null {
  const config = getLanguageConfigForPath(filePath);
  return config ? toLegacyConfig(config) : null;
}

/** All supported file extensions (with dot prefix). */
export function getSupportedExtensions(): string[] {
  return getAllSupportedExtensions().map((e) => `.${e}`);
}

/** Check if a file path has a supported extension. */
export function isSupportedFile(filePath: string): boolean {
  return isSupportedFilePath(filePath);
}
