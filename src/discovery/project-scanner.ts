/*
 * project-scanner.ts — Auto-detect projects without configuration.
 *
 * Scans a directory (and its ancestors) for project markers like
 * package.json, go.mod, Cargo.toml, etc. Returns detected language,
 * framework hints, and suggested exclusion patterns.
 *
 * Zero config: the user never needs to set up anything.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { LynxIndexMode } from '../types.js';

export interface DetectedProject {
  /** Absolute path to the project root */
  rootPath: string;
  /** Detected primary language */
  language: string;
  /** Secondary languages detected */
  secondaryLanguages: string[];
  /** Framework hints (next, express, django, etc.) */
  frameworks: string[];
  /** Project name (from package.json name field or directory name) */
  name: string;
  /** Which marker files were found */
  markers: string[];
  /** Suggested index mode */
  suggestedMode: LynxIndexMode;
  /** Confidence 0-1 */
  confidence: number;
}

/** All project markers we can detect */
const MARKERS: Record<string, { language: string; weight: number }> = {
  'package.json':              { language: 'typescript', weight: 10 },
  'tsconfig.json':             { language: 'typescript', weight: 8 },
  'go.mod':                   { language: 'go',           weight: 10 },
  'go.sum':                   { language: 'go',           weight: 5 },
  'Cargo.toml':               { language: 'rust',         weight: 10 },
  'Cargo.lock':               { language: 'rust',         weight: 5 },
  'pyproject.toml':           { language: 'python',       weight: 10 },
  'setup.py':                 { language: 'python',       weight: 8 },
  'setup.cfg':                { language: 'python',       weight: 5 },
  'requirements.txt':         { language: 'python',       weight: 4 },
  'Pipfile':                  { language: 'python',       weight: 6 },
  'Gemfile':                  { language: 'ruby',         weight: 10 },
  'Rakefile':                 { language: 'ruby',         weight: 5 },
  'pom.xml':                  { language: 'java',         weight: 8 },
  'build.gradle':             { language: 'java',         weight: 8 },
  'build.gradle.kts':         { language: 'kotlin',       weight: 8 },
  'settings.gradle':          { language: 'java',         weight: 4 },
  'build.sbt':                { language: 'scala',        weight: 8 },
  'Makefile':                 { language: 'c',            weight: 3 },
  'CMakeLists.txt':           { language: 'cpp',          weight: 10 },
  'CMakePresets.json':        { language: 'cpp',          weight: 5 },
  'meson.build':              { language: 'cpp',          weight: 8 },
  'mix.exs':                  { language: 'elixir',       weight: 10 },
  'rebar.config':             { language: 'erlang',       weight: 8 },
  'stack.yaml':               { language: 'haskell',      weight: 8 },
  'Package.swift':            { language: 'swift',        weight: 10 },
  'Project.toml':             { language: 'csharp',       weight: 8 },
  '.sln':                     { language: 'csharp',       weight: 8 },
  'pubspec.yaml':             { language: 'dart',         weight: 8 },
  'composer.json':            { language: 'php',          weight: 10 },
  '.php-cs-fixer.php':           { language: 'php',          weight: 3 },
  'deno.json':              { language: 'typescript',    weight: 5 },
  'deno.jsonc':             { language: 'typescript',    weight: 5 },
  'bun.lockb':              { language: 'typescript',    weight: 3 },
  'yarn.lock':              { language: 'typescript',    weight: 2 },
  'pnpm-lock.yaml':         { language: 'typescript',    weight: 2 },
  'next.config.ts':         { language: 'typescript',    weight: 4 },
  'next.config.js':         { language: 'typescript',    weight: 4 },
  'next.config.mjs':        { language: 'typescript',    weight: 4 },
  'nuxt.config.ts':         { language: 'typescript',    weight: 4 },
  'astro.config.mjs':       { language: 'typescript',    weight: 4 },
  'svelte.config.js':       { language: 'typescript',    weight: 4 },
  'remix.config.js':        { language: 'typescript',    weight: 4 },
  'vite.config.ts':         { language: 'typescript',    weight: 3 },
  'vite.config.js':         { language: 'typescript',    weight: 3 },
  'Dockerfile':             { language: 'docker',        weight: 2 },
  'docker-compose.yml':     { language: 'docker',        weight: 2 },
  '.github/workflows':      { language: 'ci',            weight: 1 },
};

/** Framework hints to detect from package.json dependencies */
const FRAMEWORK_HINTS: Record<string, string[]> = {
  'next': ['next'],
  'react': ['react'],
  'vue': ['vue'],
  'nuxt': ['nuxt'],
  'svelte': ['svelte'],
  'angular': ['@angular/core'],
  'express': ['express'],
  'fastify': ['fastify'],
  'nestjs': ['@nestjs/core'],
  'django': ['django'],
  'flask': ['flask'],
  'fastapi': ['fastapi'],
  'rails': ['rails'],
  'gin': ['gin'],
  'echo': ['echo'],
  'fiber': ['fiber'],
  'actix': ['actix-web'],
  'axum': ['axum'],
  'rocket': ['rocket'],
  'spring': ['spring-boot'],
  'laravel': ['laravel/framework'],
  'symfony': ['symfony/http-kernel'],
};

/**
 * Scan a directory for project markers. Returns detected projects
 * ordered by confidence (highest first).
 */
export function scanDirectory(rootPath: string): DetectedProject[] {
  const resolved = path.resolve(rootPath);
  const results: DetectedProject[] = [];

  // Scan the given directory and its immediate subdirectories (1 level)
  const candidates = [resolved];
  try {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
        candidates.push(path.join(resolved, entry.name));
      }
    }
  } catch {
    return [];
  }

  for (const candidate of candidates) {
    const project = detectAtPath(candidate);
    if (project && project.confidence > 0.2) {
      results.push(project);
    }
  }

  // Deduplicate: keep highest confidence per rootPath
  const seen = new Set<string>();
  const deduped: DetectedProject[] = [];
  for (const p of results.sort((a, b) => b.confidence - a.confidence)) {
    if (seen.has(p.rootPath)) continue;
    seen.add(p.rootPath);
    deduped.push(p);
  }

  return deduped;
}

/**
 * Scan upward from a directory to find the nearest project root.
 * Checks current dir, then parent, then grandparent, etc.
 */
export function findNearestProject(startPath: string): DetectedProject | null {
  let current = path.resolve(startPath);

  for (let i = 0; i < 6; i++) {
    const project = detectAtPath(current);
    if (project && project.confidence >= 0.3) return project;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Detect a single project at a specific directory path.
 */
function detectAtPath(dirPath: string): DetectedProject | null {
  const markers: string[] = [];
  const languages = new Map<string, number>();
  let name = path.basename(dirPath);

  // Check for marker files
  for (const [marker, info] of Object.entries(MARKERS)) {
    const fullPath = path.join(dirPath, marker);

    if (marker.endsWith('/workflows')) {
      // Directory check
      try {
        if (fs.statSync(fullPath).isDirectory()) {
          markers.push(marker);
          languages.set(info.language, (languages.get(info.language) || 0) + info.weight);
        }
      } catch { /* doesn't exist */ }
      continue;
    }

    // Special case: .sln (any file ending in .sln)
    if (marker === '.sln') {
      try {
        const entries = fs.readdirSync(dirPath);
        const slnFiles = entries.filter((e) => e.endsWith('.sln'));
        if (slnFiles.length > 0) {
          markers.push(slnFiles[0]);
          languages.set(info.language, (languages.get(info.language) || 0) + info.weight);
        }
      } catch { /* can't read dir */ }
      continue;
    }

    // File check
    try {
      if (fs.statSync(fullPath).isFile()) {
        markers.push(marker);
        languages.set(info.language, (languages.get(info.language) || 0) + info.weight);
      }
    } catch { /* doesn't exist */ }
  }

  if (markers.length === 0) return null;

  // Determine primary language
  const sorted = [...languages.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sorted[0][0];
  const secondary = sorted.slice(1).filter(([, w]) => w >= 3).map(([l]) => l);

  // Detect frameworks from package.json
  const frameworks = detectFrameworks(dirPath);

  // Try to get a better name from package.json
  if (markers.includes('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8'));
      if (pkg.name && !isGenericPackageName(pkg.name)) name = pkg.name;
    } catch { /* use directory name */ }
  } else if (markers.includes('Cargo.toml')) {
    try {
      const content = fs.readFileSync(path.join(dirPath, 'Cargo.toml'), 'utf-8');
      const m = content.match(/name\s*=\s*"([^"]+)"/);
      if (m) name = m[1];
    } catch { /* use directory name */ }
  } else if (markers.includes('pyproject.toml')) {
    try {
      const content = fs.readFileSync(path.join(dirPath, 'pyproject.toml'), 'utf-8');
      const m = content.match(/name\s*=\s*"([^"]+)"/);
      if (m) name = m[1];
    } catch { /* use directory name */ }
  }

  // Confidence: weighted score / 18 (typical score for a solid single-language project)
  const totalScore = sorted.reduce((sum, [, w]) => sum + w, 0);
  const confidence = Math.min(1, totalScore / 18);

  // Suggested mode: large projects → fast by default
  const suggestedMode: LynxIndexMode = 'fast';

  return {
    rootPath: dirPath,
    language: primary,
    secondaryLanguages: secondary,
    frameworks,
    name,
    markers,
    suggestedMode,
    confidence,
  };
}

/** Names too generic to be useful — fall back to directory name. */
const GENERIC_PACKAGE_NAMES = new Set([
  'nextapp', 'app', 'web', 'server', 'client', 'api', 'frontend',
  'backend', 'www', 'site', 'project', 'my-app', 'test', 'demo',
]);

function isGenericPackageName(name: string): boolean {
  return GENERIC_PACKAGE_NAMES.has(name.toLowerCase());
}

function detectFrameworks(dirPath: string): string[] {
  const frameworks: string[] = [];

  // Check for framework-specific config files
  const configChecks: Record<string, string> = {
    'next': 'next.config.ts',
    'nuxt': 'nuxt.config.ts',
    'astro': 'astro.config.mjs',
    'svelte': 'svelte.config.js',
    'remix': 'remix.config.js',
    'vite': 'vite.config.ts',
  };

  for (const [fw, config] of Object.entries(configChecks)) {
    try {
      if (fs.existsSync(path.join(dirPath, config)) || fs.existsSync(path.join(dirPath, config.replace('.ts', '.js')))) {
        frameworks.push(fw);
      }
    } catch { /* skip */ }
  }

  // Check package.json dependencies for framework hints
  try {
    const pkgPath = path.join(dirPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const [fw, packages] of Object.entries(FRAMEWORK_HINTS)) {
        if (frameworks.includes(fw)) continue;
        if (packages.some((p) => deps[p])) {
          frameworks.push(fw);
        }
      }
    }
  } catch { /* invalid package.json */ }

  return frameworks;
}
