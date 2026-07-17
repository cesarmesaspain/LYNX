/*
 * language-registry.ts — Maps file extensions to tree-sitter WASM grammars.
 *
 * Each entry specifies:
 *  - The tree-sitter-wasm language key (matches directory name in out/)
 *  - The node type names used by that grammar for key constructs
 *  - File extensions that map to this language
 *
 * Covers ~55 language configs. Languages with bundled WASM use
 * tree-sitter; the rest fall back to a lightweight textual extractor.
 */

export interface LanguageConfig {
  /** Language identifier. Usually matches tree-sitter-wasm out/ directory. */
  tsLang: string;
  /** File extensions (without dot) that map to this language */
  extensions: string[];
  /** Node type name used by the grammar for function/method declarations */
  functionTypes: string[];
  /** Node type name used by the grammar for class/type declarations */
  classTypes: string[];
  /** Node type name used by the grammar for function/method calls */
  callTypes: string[];
  /** Node type name used by the grammar for import/include statements */
  importTypes: string[];
  /** Node type name used by the grammar for variable/constant declarations */
  variableTypes: string[];
  /** Node type name used by the grammar for comments */
  commentTypes: string[];
  /** Whether this language has imports (vs simple includes) */
  hasImports: boolean;
  /** Whether to also use TS compiler API for this language (rich types) */
  useTSCompiler?: boolean;
}

/**
 * Core languages with accurate tree-sitter node types.
 * Additional languages use conservative generic heuristics.
 */
const TOP_LANGUAGES: LanguageConfig[] = [
  // ── TypeScript / JavaScript family ──
  {
    tsLang: 'typescript',
    extensions: ['ts'],
    functionTypes: ['function_declaration', 'arrow_function', 'method_definition'],
    classTypes: ['class_declaration', 'abstract_class_declaration'],
    callTypes: ['call_expression', 'new_expression'],
    importTypes: ['import_statement', 'export_statement'],
    variableTypes: ['variable_declaration', 'lexical_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
    useTSCompiler: true,
  },
  {
    tsLang: 'tsx',
    extensions: ['tsx'],
    functionTypes: ['function_declaration', 'arrow_function', 'method_definition'],
    classTypes: ['class_declaration', 'abstract_class_declaration'],
    callTypes: ['call_expression', 'new_expression'],
    importTypes: ['import_statement', 'export_statement'],
    variableTypes: ['variable_declaration', 'lexical_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
    useTSCompiler: true,
  },
  {
    tsLang: 'javascript',
    extensions: ['js', 'mjs', 'cjs'],
    functionTypes: ['function_declaration', 'arrow_function', 'method_definition'],
    classTypes: ['class_declaration'],
    callTypes: ['call_expression', 'new_expression'],
    importTypes: ['import_statement', 'export_statement'],
    variableTypes: ['variable_declaration', 'lexical_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Python ──
  {
    tsLang: 'python',
    extensions: ['py', 'pyw', 'pyi'],
    functionTypes: ['function_definition'],
    classTypes: ['class_definition'],
    callTypes: ['call'],
    importTypes: ['import_statement', 'import_from_statement'],
    variableTypes: ['assignment'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Go ──
  {
    tsLang: 'go',
    extensions: ['go'],
    functionTypes: ['function_declaration', 'method_declaration'],
    classTypes: ['type_declaration'],
    callTypes: ['call_expression'],
    importTypes: ['import_declaration'],
    variableTypes: ['var_declaration', 'const_declaration', 'short_var_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Rust ──
  {
    tsLang: 'rust',
    extensions: ['rs'],
    functionTypes: ['function_item', 'function_signature_item'],
    classTypes: ['struct_item', 'enum_item', 'trait_item', 'impl_item'],
    callTypes: ['call_expression', 'macro_invocation'],
    importTypes: ['use_declaration'],
    variableTypes: ['let_declaration', 'const_item', 'static_item'],
    commentTypes: ['line_comment', 'block_comment'],
    hasImports: true,
  },

  // ── Java ──
  {
    tsLang: 'java',
    extensions: ['java'],
    functionTypes: ['method_declaration', 'constructor_declaration'],
    classTypes: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callTypes: ['method_invocation', 'object_creation_expression'],
    importTypes: ['import_declaration'],
    variableTypes: ['local_variable_declaration', 'variable_declaration', 'field_declaration'],
    commentTypes: ['line_comment', 'block_comment'],
    hasImports: true,
  },

  // ── Kotlin ──
  {
    tsLang: 'kotlin',
    extensions: ['kt', 'kts'],
    functionTypes: ['function_declaration'],
    classTypes: ['class_declaration', 'object_declaration', 'interface_declaration'],
    callTypes: ['call_expression'],
    importTypes: ['import_header'],
    variableTypes: ['property_declaration', 'variable_declaration'],
    commentTypes: ['line_comment', 'block_comment'],
    hasImports: true,
  },

  // ── C / C++ ──
  {
    tsLang: 'c',
    extensions: ['c', 'h'],
    functionTypes: ['function_definition', 'function_declarator'],
    classTypes: ['struct_specifier', 'union_specifier', 'enum_specifier'],
    callTypes: ['call_expression'],
    importTypes: ['preproc_include'],
    variableTypes: ['declaration'],
    commentTypes: ['comment'],
    // Preprocessor includes are structural imports and are required to resolve
    // calls from .c files to declarations in .h files.
    hasImports: true,
  },
  {
    tsLang: 'cpp',
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
    functionTypes: ['function_definition', 'function_declarator', 'template_declaration'],
    classTypes: ['class_specifier', 'struct_specifier', 'enum_specifier'],
    callTypes: ['call_expression'],
    importTypes: ['preproc_include', 'using_declaration'],
    variableTypes: ['declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── C# ──
  {
    tsLang: 'c_sharp',
    extensions: ['cs'],
    functionTypes: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
    classTypes: ['class_declaration', 'struct_declaration', 'interface_declaration', 'enum_declaration'],
    callTypes: ['invocation_expression', 'object_creation_expression'],
    importTypes: ['using_directive'],
    variableTypes: ['variable_declaration', 'field_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Ruby ──
  {
    tsLang: 'ruby',
    extensions: ['rb', 'rake', 'gemspec'],
    functionTypes: ['method', 'singleton_method'],
    classTypes: ['class', 'module'],
    callTypes: ['call'],
    importTypes: ['call'], // Ruby uses `require` which tree-sitter parses as a call
    variableTypes: ['assignment'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Swift ──
  {
    tsLang: 'swift',
    extensions: ['swift'],
    functionTypes: ['function_declaration'],
    classTypes: ['class_declaration', 'struct_declaration', 'enum_declaration', 'protocol_declaration'],
    callTypes: ['call_expression'],
    importTypes: ['import_declaration'],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment', 'multiline_comment'],
    hasImports: true,
  },

  // ── PHP ──
  {
    tsLang: 'php',
    extensions: ['php', 'phtml'],
    functionTypes: ['function_definition', 'method_declaration', 'arrow_function'],
    classTypes: ['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration'],
    callTypes: ['function_call_expression', 'member_call_expression'],
    importTypes: ['use_declaration', 'namespace_use_group'],
    variableTypes: ['assignment_expression'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Scala ──
  {
    tsLang: 'scala',
    extensions: ['scala', 'sc'],
    functionTypes: ['function_definition', 'function_declaration'],
    classTypes: ['class_definition', 'object_definition', 'trait_definition'],
    callTypes: ['call_expression'],
    importTypes: ['import_declaration'],
    variableTypes: ['val_definition', 'var_definition', 'variable_definition'],
    commentTypes: ['comment'],
    hasImports: true,
  },

  // ── Lua ──
  {
    tsLang: 'lua',
    extensions: ['lua'],
    functionTypes: ['function_declaration', 'function_definition'],
    classTypes: [], // Lua has no native classes — uses tables
    callTypes: ['function_call'],
    importTypes: [], // Lua uses `require()` which is a function call
    variableTypes: ['variable_declaration', 'assignment_statement'],
    commentTypes: ['comment'],
    hasImports: false,
  },

  // ── Config / data languages ──
  {
    tsLang: 'json',
    extensions: ['json', 'jsonc', 'json5'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: [],
    variableTypes: [],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'yaml',
    extensions: ['yaml', 'yml'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: [],
    variableTypes: [],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'toml',
    extensions: ['toml'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: [],
    variableTypes: [],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'xml',
    extensions: ['xml', 'xsl', 'xslt', 'xsd'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: [],
    variableTypes: [],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'sql',
    extensions: ['sql', 'psql', 'mysql'],
    functionTypes: ['function_definition', 'procedure_definition'],
    classTypes: [],
    callTypes: ['function_call'],
    importTypes: [],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'html',
    extensions: ['html', 'htm'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: [],
    variableTypes: [],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'css',
    extensions: ['css'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: ['import_statement'],
    variableTypes: ['rule_set'],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'scss',
    extensions: ['scss'],
    functionTypes: ['mixin_declaration', 'function_declaration'],
    classTypes: [],
    callTypes: [], // @include mixin-name
    importTypes: ['import_statement'],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'bash',
    extensions: ['sh', 'bash', 'zsh', 'fish'],
    functionTypes: ['function_definition'],
    classTypes: [],
    callTypes: ['command'],
    importTypes: [], // source / . other-file
    variableTypes: ['variable_assignment'],
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'dockerfile',
    extensions: ['dockerfile', 'Dockerfile'],
    functionTypes: [],
    classTypes: [],
    callTypes: [], // RUN, CMD, etc.
    importTypes: [], // FROM, COPY
    variableTypes: [], // ARG, ENV
    commentTypes: ['comment'],
    hasImports: false,
  },
  {
    tsLang: 'markdown',
    extensions: ['md', 'mdx', 'markdown'],
    functionTypes: [],
    classTypes: [],
    callTypes: [],
    importTypes: [],
    variableTypes: [],
    commentTypes: [],
    hasImports: false,
  },
  // ── Additional languages with generic heuristics ──
  {
    tsLang: 'dart',
    extensions: ['dart'],
    functionTypes: ['function_declaration', 'method_declaration'],
    classTypes: ['class_declaration', 'mixin_declaration', 'enum_declaration'],
    callTypes: ['function_expression_invocation', 'method_invocation'],
    importTypes: ['import_statement', 'export_statement'],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'elixir',
    extensions: ['ex', 'exs'],
    functionTypes: ['function', 'anonymous_function'],
    classTypes: ['module', 'defmodule'],
    callTypes: ['call'],
    importTypes: ['import', 'alias', 'require'],
    variableTypes: ['assignment'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'haskell',
    extensions: ['hs'],
    functionTypes: ['function', 'signature', 'binding'],
    classTypes: ['class', 'instance', 'data'],
    callTypes: ['application'],
    importTypes: ['import'],
    variableTypes: ['declaration'],
    commentTypes: ['comment', 'haddock'],
    hasImports: true,
  },
  {
    tsLang: 'clojure',
    extensions: ['clj', 'cljs', 'edn'],
    functionTypes: ['defn', 'fn'],
    classTypes: [], // defrecord, deftype
    callTypes: ['list_lit'],
    importTypes: ['ns', 'require', 'use'],
    variableTypes: ['def'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'elisp',
    extensions: ['el'],
    functionTypes: ['defun'],
    classTypes: [],
    callTypes: ['list'],
    importTypes: ['require'],
    variableTypes: ['defvar', 'defconst', 'setq'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'erlang',
    extensions: ['erl', 'hrl'],
    functionTypes: ['function_clause'],
    classTypes: ['module'],
    callTypes: ['function_call'],
    importTypes: ['import_attribute', 'export_attribute'],
    variableTypes: ['assignment', 'match'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'ocaml',
    extensions: ['ml', 'mli'],
    functionTypes: ['let_binding', 'let_expression'],
    classTypes: ['module_type', 'module_definition', 'class_definition'],
    callTypes: ['application_expression'],
    importTypes: ['open_statement', 'include_statement'],
    variableTypes: ['let_binding'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'nim',
    extensions: ['nim'],
    functionTypes: ['proc_declaration', 'func_declaration', 'method_declaration'],
    classTypes: ['type_declaration'],
    callTypes: ['call_expression'],
    importTypes: ['import_statement', 'include_statement'],
    variableTypes: ['var_declaration', 'let_declaration', 'const_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'zig',
    extensions: ['zig'],
    functionTypes: ['function_declaration'],
    classTypes: ['struct_declaration', 'enum_declaration', 'union_declaration'],
    callTypes: ['call_expression'],
    importTypes: ['using_namespace', 'import_expression'],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'groovy',
    extensions: ['groovy'],
    functionTypes: ['method_declaration', 'closure'],
    classTypes: ['class_declaration', 'enum_declaration', 'trait_declaration'],
    callTypes: ['method_call_expression'],
    importTypes: ['import_declaration'],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'solidity',
    extensions: ['sol'],
    functionTypes: ['function_definition', 'constructor_definition', 'fallback_receive_definition'],
    classTypes: ['contract_definition', 'interface_definition', 'library_definition'],
    callTypes: ['call_expression'],
    importTypes: ['import_directive'],
    variableTypes: ['state_variable_declaration', 'variable_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },
  {
    tsLang: 'systemverilog',
    extensions: ['sv', 'svh', 'v'],
    functionTypes: ['function_declaration', 'task_declaration'],
    classTypes: ['class_declaration', 'module_declaration', 'interface_declaration'],
    callTypes: ['function_call'],
    importTypes: ['import_declaration', 'include_statement'],
    variableTypes: ['variable_declaration'],
    commentTypes: ['comment'],
    hasImports: true,
  },
];

const genericFunctionTypes = [
  'function_declaration',
  'function_definition',
  'method_declaration',
  'method_definition',
  'procedure_declaration',
  'proc_declaration',
  'func_declaration',
  'subroutine',
  'rule',
];

const genericClassTypes = [
  'class_declaration',
  'class_definition',
  'struct_declaration',
  'struct_specifier',
  'interface_declaration',
  'enum_declaration',
  'type_declaration',
  'module_declaration',
  'object_declaration',
];

const genericCallTypes = [
  'call_expression',
  'function_call',
  'function_call_expression',
  'method_invocation',
  'invocation_expression',
  'command',
];

const genericImportTypes = [
  'import_statement',
  'import_declaration',
  'include_statement',
  'use_declaration',
  'using_directive',
  'preproc_include',
];

const genericVariableTypes = [
  'variable_declaration',
  'declaration',
  'assignment',
  'assignment_expression',
  'let_declaration',
  'const_declaration',
  'property_declaration',
];

function genericLanguage(tsLang: string, extensions: string[], hasImports = false): LanguageConfig {
  return {
    tsLang,
    extensions,
    functionTypes: genericFunctionTypes,
    classTypes: genericClassTypes,
    callTypes: genericCallTypes,
    importTypes: hasImports ? genericImportTypes : [],
    variableTypes: genericVariableTypes,
    commentTypes: ['comment', 'line_comment', 'block_comment'],
    hasImports,
  };
}

const ADDITIONAL_LANGUAGES: LanguageConfig[] = [
  genericLanguage('cmake', ['cmake', 'CMakeLists.txt'], true),
  genericLanguage('cuda', ['cu', 'cuh'], true),
  genericLanguage('elm', ['elm'], true),
  genericLanguage('fsharp', ['fs', 'fsi', 'fsx'], true),
  genericLanguage('graphql', ['graphql', 'gql']),
  genericLanguage('hcl', ['hcl', 'tf', 'tfvars'], true),
  genericLanguage('ini', ['ini', 'cfg', 'conf']),
  genericLanguage('julia', ['jl'], true),
  genericLanguage('makefile', ['mk', 'make', 'Makefile', 'makefile']),
  genericLanguage('matlab', ['m'], true),
  genericLanguage('nix', ['nix'], true),
  genericLanguage('objc', ['m', 'mm'], true),
  genericLanguage('perl', ['pl', 'pm', 't'], true),
  genericLanguage('powershell', ['ps1', 'psm1', 'psd1'], true),
  genericLanguage('prisma', ['prisma']),
  genericLanguage('protobuf', ['proto'], true),
  genericLanguage('r', ['r', 'R'], true),
  genericLanguage('svelte', ['svelte'], true),
  genericLanguage('vue', ['vue'], true),
];

export const ALL_LANGUAGES: LanguageConfig[] = [...TOP_LANGUAGES, ...ADDITIONAL_LANGUAGES];

// ── Extension → LanguageConfig index ──

const extMap = new Map<string, number>();

for (let i = 0; i < ALL_LANGUAGES.length; i++) {
  for (const ext of ALL_LANGUAGES[i].extensions) {
    extMap.set(ext, i);
  }
}

/**
 * Get the LanguageConfig for a file extension.
 * Returns null for unsupported extensions.
 */
export function getLanguageConfig(extension: string): LanguageConfig | null {
  const key = extension.replace(/^\./, '').toLowerCase();
  return extMap.has(key) ? ALL_LANGUAGES[extMap.get(key)!] : null;
}

export function getLanguageConfigForPath(filePath: string): LanguageConfig | null {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.toLowerCase() || normalized.toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() || '' : base;

  for (const [key, index] of extMap) {
    const compound = key.toLowerCase();
    if (compound.includes('.') && (base === compound || base.endsWith('.' + compound))) {
      return ALL_LANGUAGES[index];
    }
  }

  const candidates = [
    base,
    base.replace(/^\./, ''),
    ext,
  ];

  for (const key of candidates) {
    const config = getLanguageConfig(key);
    if (config) return config;
  }

  return null;
}

/**
 * Check if a file extension is supported by any registered language.
 */
export function isSupportedExtension(extension: string): boolean {
  return extMap.has(extension.replace(/^\./, '').toLowerCase());
}

export function isSupportedFilePath(filePath: string): boolean {
  return getLanguageConfigForPath(filePath) !== null;
}

/**
 * All registered file extensions (for file discovery).
 */
export function getAllSupportedExtensions(): string[] {
  return Array.from(extMap.keys());
}

/**
 * List of all supported language names.
 */
export function getAllLanguageNames(): string[] {
  return ALL_LANGUAGES.map((l) => l.tsLang);
}
