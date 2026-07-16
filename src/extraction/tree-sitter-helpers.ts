/* Syntax-tree helper functions kept separate from parser orchestration. */

import { Node as SyntaxNode } from 'web-tree-sitter';
import * as path from 'node:path';
import type { LanguageConfig } from './language-registry.js';
import type { TSExtractedDecorator, TSExtractedThrow } from './tree-sitter-extractor.js';

function definitionName(node: SyntaxNode, source: string, lang: string): string | null {
  // Try name/identifier child first (most languages)
  const nameNode = node.childForFieldName?.('name');
  if (nameNode) return nameNode.text;

  // Anonymous JavaScript/TypeScript function nodes are already represented by
  // their enclosing variable declaration. Treating the first parameter as the
  // function name creates false symbols such as `string` for `const f = string => ...`.
  if (
    ['javascript', 'typescript', 'tsx'].includes(lang) &&
    ['arrow_function', 'function_expression'].includes(node.type)
  ) {
    return null;
  }

  // Fallback: find first identifier descendant
  const identifiers = node.descendantsOfType(['identifier', 'property_identifier', 'word']);
  if (identifiers.length > 0) return identifiers[0].text;

  // Last resort: use first line of the node
  const text = node.text;
  const firstLine = text.split('\n')[0];
  // Try to extract name from common patterns
  const match = firstLine.match(/(?:function|def|func|fn|class|struct|enum|trait|interface|module|object)\s+(\w+)/);
  if (match) return match[1];

  return null;
}

export function findEnclosingFunction(node: SyntaxNode, config: LanguageConfig): string | null {
  let current = node.parent;
  while (current) {
    if (config.functionTypes.includes(current.type)) {
      return definitionName(current, '', config.tsLang);
    }
    current = current.parent;
  }
  return null;
}

export function findEnclosingClass(node: SyntaxNode, config: LanguageConfig, source: string): string | null {
  let current = node.parent;
  while (current) {
    if (config.classTypes.includes(current.type)) {
      return definitionName(current, source, config.tsLang);
    }
    current = current.parent;
  }
  return null;
}

export function extractSignature(node: SyntaxNode, source: string): string {
  const text = node.text;
  const firstLine = text.split('\n')[0];
  // Return up to the first { or :
  const endIdx = Math.min(
    firstLine.indexOf('{') !== -1 ? firstLine.indexOf('{') : Infinity,
    firstLine.indexOf(':') !== -1 ? firstLine.indexOf(':') : Infinity,
    firstLine.length
  );
  return firstLine.substring(0, endIdx).trim();
}

export function extractParamNames(node: SyntaxNode, source: string, lang: string): string[] {
  const params = node.descendantsOfType(['parameter', 'formal_parameter', 'param']);
  return params.map((p: SyntaxNode) => {
    const text = p.text.split('\n')[0].trim();
    const match = text.match(/^(\w+)/);
    return match ? match[1] : text.substring(0, 30);
  });
}

export function extractTypeAnnotation(node: SyntaxNode, source: string, lang: string): string | undefined {
  const types = node.descendantsOfType(['type_annotation', 'type', 'return_type']);
  if (types.length > 0) return types[0].text.trim();
  return undefined;
}

export function extractBaseNames(node: SyntaxNode): string[] {
  // Try tree-sitter fields first
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'class_heritage' || child.type === 'implements_clause' || child.type === 'extends_clause' || child.type === 'superclass_clause') {
      for (const ident of child.descendantsOfType(['identifier', 'type_identifier'])) {
        names.push(ident.text);
      }
    }
    if (child.type === 'interface_extends' || child.type === 'extends_clause') {
      for (const ident of child.descendantsOfType(['identifier', 'type_identifier'])) {
        names.push(ident.text);
      }
    }
  }
  if (names.length > 0) return names;

  // Fallback: text-based extraction
  const text = node.text.split('{')[0] || '';
  const match = text.match(/\b(?:extends|implements)\s+([^{]+)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export function extractEnumMembers(node: SyntaxNode): string[] {
  return node
    .descendantsOfType(['property_identifier', 'identifier'])
    .map((child: SyntaxNode) => child.text)
    .filter((name: string) => name && name !== definitionName(node, '', ''));
}

export function isNodeExported(
  node: SyntaxNode,
  source: string,
  lang: string
): boolean {
  const text = node.text;
  const firstLine = text.split('\n')[0].trim();
  if (
    firstLine.startsWith('export ') ||
    firstLine.startsWith('pub ') ||
    firstLine.startsWith('public ') ||
    firstLine.includes(' @export')
  ) return true;
  // Tree-sitter: export is a parent node (export_statement), not inside the
  // declaration node text. Check if any ancestor is an export_statement.
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'export_statement') return true;
    parent = parent.parent;
  }
  return false;
}

// ── Throw extraction ─────────────────────────────────────────────

export function extractThrows(
  rootNode: SyntaxNode,
  source: string,
  config: LanguageConfig,
  moduleQn: string,
  throws: TSExtractedThrow[]
): void {
  const throwTypes = ['throw_statement', 'raise_statement', 'throw_expression', 'raise'];
  const throwNodes = rootNode.descendantsOfType(throwTypes);
  if (throwNodes.length === 0) return;

  for (const tn of throwNodes) {
    const startLine = tn.startPosition.row + 1;
    const enclosingFunc = findEnclosingFunction(tn, config);
    const enclosingFuncQn = enclosingFunc
      ? `${moduleQn}.${enclosingFunc}`
      : `${moduleQn}._global`;

    let exceptionName = '';
    for (const child of tn.children) {
      if (child.type === 'new_expression') {
        const idNodes = child.descendantsOfType(['identifier', 'type_identifier']);
        if (idNodes.length > 0) exceptionName = idNodes[0].text;
      }
      if (!exceptionName) {
        const idents = child.descendantsOfType(['identifier', 'type_identifier']);
        if (idents.length > 0) exceptionName = idents[0].text;
      }
    }
    if (!exceptionName) {
      const text = tn.text;
      const m = text.match(/(?:throw|raise)\s+(?:new\s+)?(\w+)/i);
      if (m) exceptionName = m[1];
    }
    if (exceptionName) {
      throws.push({ exceptionName, enclosingFuncQn, startLine });
    }
  }
}

// ── Decorator extraction ──────────────────────────────────────────

export function extractDecorators(
  rootNode: SyntaxNode,
  config: LanguageConfig,
  moduleQn: string,
  decorators: TSExtractedDecorator[]
): void {
  const decoratorTypes = ['decorator', 'annotation', 'attribute'];
  for (const node of rootNode.descendantsOfType(decoratorTypes)) {
    const decoratorText = node.text;
    let cleaned = decoratorText;
    if (cleaned.startsWith('@')) cleaned = cleaned.slice(1);
    if (cleaned.startsWith('#')) cleaned = cleaned.slice(1);
    if (cleaned.startsWith('[')) cleaned = cleaned.slice(1).replace(/\]$/, '');
    const parenIdx = cleaned.indexOf('(');
    const name = parenIdx > 0 ? cleaned.substring(0, parenIdx).trim() : cleaned.trim();
    if (!name || name.length === 0) continue;

    // Find decorated target: walk parent chain up past decorator nodes
    let target: SyntaxNode | null = node;
    while (target && (decoratorTypes.includes(target.type) || target.type === 'decorator')) {
      target = target.nextNamedSibling || target.parent;
      if (target && !decoratorTypes.includes(target.type)) break;
      target = target?.parent || null;
    }
    // Better: find first non-decorator sibling, then use prev-sibling parent
    // Walk parent up to the first non-decorator parent
    let targetParent = node.parent;
    while (targetParent && decoratorTypes.includes(targetParent.type)) {
      targetParent = targetParent.parent;
    }

    let targetQn = moduleQn + '._global';
    if (targetParent) {
      const isClass = config.classTypes.includes(targetParent.type);
      const isFunc = config.functionTypes.includes(targetParent.type) ||
                     targetParent.type === 'method_definition' ||
                     targetParent.type === 'arrow_function';
      if (isClass || isFunc) {
        const targetName = targetParent.childForFieldName?.('name')?.text
          || targetParent.descendantsOfType(['identifier', 'type_identifier'])[0]?.text;
        if (targetName) {
          targetQn = moduleQn + '.' + targetName;
          // For methods inside classes, include class name
          if (isFunc) {
            const gp = targetParent.parent;
            if (gp && config.classTypes.includes(gp.type)) {
              const className = gp.childForFieldName?.('name')?.text
                || gp.descendantsOfType(['identifier', 'type_identifier'])[0]?.text;
              if (className) targetQn = moduleQn + '.' + className + '.' + targetName;
            }
          }
        }
      }
    }

    decorators.push({
      name,
      targetQn,
      startLine: node.startPosition.row + 1,
    });
  }
}

// ── Utility ───────────────────────────────────────────────────────

export function filePathToModuleQn(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const withoutExt = filePath.replace(/\.[^.]+$/, '');
  const qn = withoutExt
    .replace(/^\//, '')
    .replace(/\//g, '.')
    .replace(/\\/g, '.');
  const parts = qn.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === 'index') parts.pop();
  if (parts.length > 1 && parts[0] === 'src') parts.shift();
  const moduleQn = parts.join('.') || path.basename(withoutExt) || 'root';
  // Same-stem headers and implementations must not share symbol identities:
  // otherwise a prototype upsert can replace the real source definition.
  return /\.(?:h|hh|hpp|hxx)$/.test(extension) ? `${moduleQn}.__header` : moduleQn;
}

export function countLines(source: string): number {
  if (source.length === 0) return 1;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
