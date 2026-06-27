/*
 * The core of this plugin was conceived by pi0 and is taken from the following repository:
 * https://github.com/unjs/unbuild/blob/main/src/builder/plugins/cjs.ts
 * license: https://github.com/unjs/unbuild/blob/main/LICENSE
 */

import MagicString from 'magic-string'
import type { SourceMapInput } from 'rollup'
import type { Plugin } from 'vite'

import { supportImportMetaPaths } from '../electron'

const CJSyntaxRe = /__filename|__dirname|require\(|require\.resolve\(/

const CJSShim_normal = `
// -- CommonJS Shims --
import __cjs_url__ from 'node:url';
import __cjs_path__ from 'node:path';
import __cjs_mod__ from 'node:module';
const __filename = __cjs_url__.fileURLToPath(import.meta.url);
const __dirname = __cjs_path__.dirname(__filename);
const require = __cjs_mod__.createRequire(import.meta.url);
`

const CJSShim_node_20_11 = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`

// Variable names provided by the CJS shim
const CJSIdentifiers = new Set(['__filename', '__dirname', 'require'])

// Walk an ESTree-compatible AST (iteratively, to avoid call-stack overflow on large
// bundles) and return true as soon as a real identifier reference to a CJS global is
// found.  String literals are represented in the AST as Literal nodes rather than
// Identifier nodes, so import-like text embedded inside strings — the false-match
// trigger in issue #906 — cannot produce a hit here.
//
// Non-computed property keys (e.g. `{ __dirname: val }`) and non-computed member
// expression properties (e.g. `obj.__dirname`) are skipped because they are static
// names, not variable references.
type AstNode = { type?: string; name?: string; computed?: boolean; [key: string]: unknown }

function hasCJSIdentifier(root: AstNode): boolean {
  const queue: AstNode[] = [root]
  while (queue.length > 0) {
    const node = queue.pop()
    if (!node || typeof node !== 'object' || !node.type) continue

    if (node.type === 'Identifier' && typeof node.name === 'string' && CJSIdentifiers.has(node.name)) return true

    for (const key of Object.keys(node)) {
      // Skip positional metadata and the type discriminant — not child nodes
      if (key === 'type' || key === 'start' || key === 'end') continue
      // Non-computed property keys / member-expression properties are static names,
      // not variable references; skip them to avoid false positives
      if (
        (node.type === 'Property' && key === 'key' && !node.computed) ||
        (node.type === 'MethodDefinition' && key === 'key' && !node.computed) ||
        (node.type === 'MemberExpression' && key === 'property' && !node.computed)
      )
        continue

      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object') queue.push(c as AstNode)
        }
      } else if (child && typeof child === 'object' && 'type' in child) {
        queue.push(child as AstNode)
      }
    }
  }
  return false
}

export default function esmShimPlugin(): Plugin {
  const CJSShim = supportImportMetaPaths() ? CJSShim_node_20_11 : CJSShim_normal

  return {
    name: 'vite:esm-shim',
    apply: 'build',
    enforce: 'post',
    // Regular method (not an arrow function) so the bundler can bind `this` to its
    // PluginContext, giving access to `this.parse`. The `this` type is inferred from
    // vite's `Plugin.renderChunk` (rolldown's PluginContext), which exposes `parse`.
    renderChunk(code, _chunk, { format, sourcemap }): { code: string; map?: SourceMapInput } | null {
      if (format !== 'es') return null
      if (code.includes(CJSShim) || !CJSyntaxRe.test(code)) return null

      // Use the bundler's own parser to confirm that the chunk contains real CJS
      // identifier references (not import-like text inside a string literal).
      // AST parsing represents string contents as Literal nodes, so a match here
      // means an actual identifier, not a false positive from embedded strings.
      // If parsing fails for any reason, the regex pre-check above already passed,
      // so we fall through and inject conservatively.
      try {
        if (!hasCJSIdentifier(this.parse(code) as unknown as AstNode)) return null
      } catch {
        // parse() unavailable or failed — regex pre-check already passed, proceed
      }

      // Inject the shim at offset 0 (prepend).  ESM ImportDeclarations are hoisted
      // regardless of their syntactic position within the module body, so placing them
      // before existing statements is always valid per the ECMAScript grammar.
      // This eliminates the "find last import via regex" strategy that produced a
      // false offset inside a large string literal in issue #906, corrupting the chunk.
      const s = new MagicString(code)
      s.prepend(CJSShim)
      return {
        code: s.toString(),
        map: sourcemap ? s.generateMap({ hires: 'boundary' }) : null
      }
    }
  }
}
