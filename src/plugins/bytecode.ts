import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import colors from 'picocolors'
import { type Plugin, type LibraryOptions, type Rolldown, normalizePath } from 'vite'
import * as babel from '@babel/core'
import MagicString from 'magic-string'
import { getElectronPath } from '../electron'
import { toRelativePath } from '../utils'

// Inspired by https://github.com/bytenode/bytenode

function getBytecodeCompilerPath(): string {
  // Resolve the compiler script relative to this module (walking up to the package
  // root) rather than by package name, so the path stays correct for forks/renames.
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = path.join(dir, 'bin', 'electron-bytecode.cjs')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error('Could not locate bin/electron-bytecode.cjs for the bytecode plugin')
    }
    dir = parent
  }
}

let bytecodeId = 0

function compileToBytecode(code: string, renderer: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const electronPath = getElectronPath()
    const bytecodePath = getBytecodeCompilerPath()

    // The compiler launches a headless Electron app, which needs a display on Linux.
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      reject(
        new Error(
          'Compiling bytecode launches a headless Electron process, which requires a display on Linux. ' +
            'Run the build under a virtual framebuffer, e.g. `xvfb-run --auto-servernum electron-vite build`, ' +
            'or set the DISPLAY environment variable.'
        )
      )
      return
    }

    // Compile in a real Electron process whose V8 isolate matches the one that will load
    // the cache. On V8 14.8+ (Electron 42+) the code cache is bound to a snapshot/isolate
    // checksum (header @16) AND a flag hash that both differ per process type, so a cache
    // produced in the wrong process type is rejected (and patching the header corrupts
    // execution). ELECTRON_RUN_AS_NODE is never used, as its isolate matches neither the
    // main nor the renderer process:
    //   - main / node chunks -> the Electron browser (main) process
    //   - preload chunks     -> a renderer process (a hidden window whose sandbox:false
    //                           preload performs the compile)
    // A GUI process has no usable stdio pipe, so code in / cache out go through temp files.
    // The id is monotonic within the process and namespaced by pid, keeping concurrent
    // compilations (and parallel electron-vite builds) from colliding.
    const id = `${process.pid}-${bytecodeId++}`
    const inFile = path.join(os.tmpdir(), `electron-vite-bytecode-${id}.in.js`)
    const outFile = path.join(os.tmpdir(), `electron-vite-bytecode-${id}.out.jsc`)

    const cleanup = (): void => {
      fs.rmSync(inFile, { force: true })
      fs.rmSync(outFile, { force: true })
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_VITE_BYTECODE_IN: inFile,
      ELECTRON_VITE_BYTECODE_OUT: outFile
    }
    delete env.ELECTRON_RUN_AS_NODE
    if (renderer) {
      env.ELECTRON_VITE_BYTECODE_RENDERER = '1'
    }

    try {
      fs.writeFileSync(inFile, code)
    } catch (err) {
      cleanup()
      reject(err as Error)
      return
    }

    const proc = spawn(electronPath, [bytecodePath], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    if (proc.stderr) {
      proc.stderr.on('data', chunk => {
        stderr += chunk.toString()
      })
    }

    proc.on('error', err => {
      cleanup()
      reject(err)
    })

    // Read the cache only after the process exits. Unlike the previous stdout/exit race
    // (which could resolve with a truncated or empty buffer), this makes the output
    // deterministic and surfaces a real error instead of silently emitting a bad chunk.
    proc.on('exit', exitCode => {
      let data: Buffer | undefined
      try {
        data = fs.readFileSync(outFile)
      } catch {
        data = undefined
      }
      cleanup()
      if (data && data.length > 0) {
        resolve(data)
      } else {
        reject(
          new Error(
            `Failed to compile chunk to bytecode (exit code ${exitCode ?? 'null'}).${
              stderr ? `\n${stderr.trim()}` : ''
            }`
          )
        )
      }
    })
  })
}

const bytecodeModuleLoaderCode = [
  `"use strict";`,
  `const fs = require("fs");`,
  `const path = require("path");`,
  `const vm = require("vm");`,
  `const v8 = require("v8");`,
  `const Module = require("module");`,
  `v8.setFlagsFromString("--no-lazy");`,
  `v8.setFlagsFromString("--no-flush-bytecode");`,
  `const COMPILE_PARAMS = ["exports", "require", "module", "__filename", "__dirname"];`,
  `const SOURCE_HASH_OFFSET = 8;`,
  `function sourceLength(bytecodeBuffer) {`,
  `  // The low 28 bits of the source hash hold the source length; the high bits are V8`,
  `  // source-hash flags (e.g. the "wrapped" bit set by vm.compileFunction).`,
  `  return bytecodeBuffer.readUInt32LE(SOURCE_HASH_OFFSET) & 0x0fffffff;`,
  `};`,
  `function placeholderBody(len, filename) {`,
  `  // A same-length body so the cache's source hash matches. Its content is ignored at`,
  `  // execution (V8 runs the cached bytecode) but must be UNIQUE per file, otherwise V8's`,
  `  // in-isolate compilation cache returns an earlier module's compiled function and`,
  `  // drops this file's cached data, executing the wrong (placeholder) source.`,
  `  const tag = "/*" + filename + " ";`,
  `  if (tag.length + 2 <= len) {`,
  `    return tag + " ".repeat(len - tag.length - 2) + "*/";`,
  `  }`,
  `  if (len >= 4) {`,
  `    return "/*" + (filename + " ").slice(0, len - 4).padEnd(len - 4, " ") + "*/";`,
  `  }`,
  `  return " ".repeat(len);`,
  `};`,
  `Module._extensions[".jsc"] = Module._extensions[".cjsc"] = function (module, filename) {`,
  `  const bytecodeBuffer = fs.readFileSync(filename);`,
  `  if (!Buffer.isBuffer(bytecodeBuffer)) {`,
  `    throw new Error("BytecodeBuffer must be a buffer object.");`,
  `  }`,
  `  const placeholder = placeholderBody(sourceLength(bytecodeBuffer), filename);`,
  `  const compiledWrapper = vm.compileFunction(placeholder, COMPILE_PARAMS, {`,
  `    filename: filename,`,
  `    cachedData: bytecodeBuffer`,
  `  });`,
  `  if (compiledWrapper.cachedDataRejected) {`,
  `    throw new Error("Invalid or incompatible cached data (cachedDataRejected)");`,
  `  }`,
  `  const require = function (id) {`,
  `    return module.require(id);`,
  `  };`,
  `  require.resolve = function (request, options) {`,
  `    return Module._resolveFilename(request, module, false, options);`,
  `  };`,
  `  if (process.mainModule) {`,
  `    require.main = process.mainModule;`,
  `  }`,
  `  require.extensions = Module._extensions;`,
  `  require.cache = Module._cache;`,
  `  const dirname = path.dirname(filename);`,
  `  return compiledWrapper.call(module.exports, module.exports, require, module, filename, dirname);`,
  `};`
]

const bytecodeChunkExtensionRE = /.(jsc|cjsc)$/

export interface BytecodeOptions {
  chunkAlias?: string | RegExp | (string | RegExp)[]
  transformArrowFunctions?: boolean
  removeBundleJS?: boolean
  protectedStrings?: string[]
}

/**
 * Compile source code to v8 bytecode.
 *
 * @deprecated use `build.bytecode` config option instead
 */
export function bytecodePlugin(options: BytecodeOptions = {}): Plugin | null {
  if (process.env.NODE_ENV_ELECTRON_VITE !== 'production') {
    return null
  }

  const { chunkAlias = [], transformArrowFunctions = true, removeBundleJS = true, protectedStrings = [] } = options
  const _chunkAlias = Array.isArray(chunkAlias) ? chunkAlias : [chunkAlias]

  const transformAllChunks = _chunkAlias.length === 0
  const isBytecodeChunk = (chunkName: string): boolean => {
    return (
      transformAllChunks ||
      _chunkAlias.some(alias => (alias instanceof RegExp ? alias.test(chunkName) : alias === chunkName))
    )
  }

  const plugins: babel.PluginItem[] = []

  if (transformArrowFunctions) {
    plugins.push('@babel/plugin-transform-arrow-functions')
  }

  if (protectedStrings.length > 0) {
    plugins.push([protectStringsPlugin, { protectedStrings: new Set(protectedStrings) }])
  }

  const shouldTransformBytecodeChunk = plugins.length !== 0

  const _transform = (
    code: string,
    sourceMaps: boolean = false
  ): { code: string; map?: Rolldown.SourceMapInput } | null => {
    const re = babel.transform(code, { plugins, sourceMaps })
    return re ? { code: re.code || '', map: re.map } : null
  }

  const useStrict = '"use strict";'
  const bytecodeModuleLoader = 'bytecode-loader.cjs'

  let supported = false
  // Preload runs in a renderer-type V8 isolate (a different snapshot/flag hash than the
  // browser/main process), so its chunks must be compiled in a renderer process.
  let isPreload = false

  return {
    name: 'vite:bytecode',
    apply: 'build',
    enforce: 'post',
    configResolved(config): void {
      if (supported) {
        return
      }
      isPreload = config.plugins.some(p => p.name === 'vite:electron-preload-config-preset')
      const useInRenderer = config.plugins.some(p => p.name === 'vite:electron-renderer-config-preset')
      if (useInRenderer) {
        config.logger.warn(colors.yellow('bytecodePlugin does not support renderer.'))
        return
      }
      const build = config.build
      const resolvedOutputs = resolveBuildOutputs(build.rolldownOptions.output, build.lib)
      if (resolvedOutputs) {
        const outputs = Array.isArray(resolvedOutputs) ? resolvedOutputs : [resolvedOutputs]
        const output = outputs[0]
        if (output.format === 'es') {
          config.logger.warn(
            colors.yellow(
              'bytecodePlugin does not support ES module, please remove "type": "module" ' +
                'in package.json or set build.rollupOptions.output.format (or build.rolldownOptions.output.format) to "cjs".'
            )
          )
        }
        supported = output.format === 'cjs' && !useInRenderer
      }
    },
    renderChunk(code, chunk, { sourcemap }): { code: string; map?: Rolldown.SourceMapInput } | null {
      if (supported && isBytecodeChunk(chunk.name) && shouldTransformBytecodeChunk) {
        return _transform(code, !!sourcemap)
      }
      return null
    },
    async generateBundle(_, output): Promise<void> {
      if (!supported) {
        return
      }
      const _chunks = Object.values(output)
      const chunks = _chunks.filter(
        chunk => chunk.type === 'chunk' && isBytecodeChunk(chunk.name)
      ) as Rolldown.OutputChunk[]

      if (chunks.length === 0) {
        return
      }

      const bytecodeChunks = chunks.map(chunk => chunk.fileName)
      const nonEntryChunks = chunks.filter(chunk => !chunk.isEntry).map(chunk => path.basename(chunk.fileName))

      const pattern = nonEntryChunks.map(chunk => `(${chunk})`).join('|')
      const bytecodeRE = pattern ? new RegExp(`require\\(\\S*(?=(${pattern})\\S*\\))`, 'g') : null

      const getBytecodeLoaderBlock = (chunkFileName: string): string => {
        return `require("${toRelativePath(bytecodeModuleLoader, normalizePath(chunkFileName))}");`
      }

      let bytecodeChunkCount = 0

      const bundles = Object.keys(output)

      await Promise.all(
        bundles.map(async name => {
          const chunk = output[name]
          if (chunk.type === 'chunk') {
            let _code = chunk.code
            if (bytecodeRE) {
              let match: RegExpExecArray | null
              let s: MagicString | undefined
              while ((match = bytecodeRE.exec(_code))) {
                s ||= new MagicString(_code)
                const [prefix, chunkName] = match
                const len = prefix.length + chunkName.length
                s.overwrite(match.index, match.index + len, prefix + chunkName + 'c', {
                  contentOnly: true
                })
              }
              if (s) {
                _code = s.toString()
              }
            }
            if (bytecodeChunks.includes(name)) {
              const bytecodeBuffer = await compileToBytecode(_code, isPreload)
              this.emitFile({
                type: 'asset',
                fileName: name + 'c',
                source: bytecodeBuffer
              })
              if (!removeBundleJS) {
                this.emitFile({
                  type: 'asset',
                  fileName: '_' + chunk.fileName,
                  source: chunk.code
                })
              }
              if (chunk.isEntry) {
                const bytecodeLoaderBlock = getBytecodeLoaderBlock(chunk.fileName)
                const bytecodeModuleBlock = `require("./${path.basename(name) + 'c'}");`
                const code = `${useStrict}\n${bytecodeLoaderBlock}\n${bytecodeModuleBlock}\n`
                chunk.code = code
              } else {
                delete output[chunk.fileName]
              }
              bytecodeChunkCount += 1
            } else {
              if (chunk.isEntry) {
                let hasBytecodeMoudle = false
                const idsToHandle = new Set([...chunk.imports, ...chunk.dynamicImports])
                for (const moduleId of idsToHandle) {
                  if (bytecodeChunks.includes(moduleId)) {
                    hasBytecodeMoudle = true
                    break
                  }
                  const moduleInfo = this.getModuleInfo(moduleId)
                  if (moduleInfo) {
                    const { importers, dynamicImporters } = moduleInfo
                    for (const importerId of importers) idsToHandle.add(importerId)
                    for (const importerId of dynamicImporters) idsToHandle.add(importerId)
                  }
                }
                _code = hasBytecodeMoudle
                  ? _code.replace(
                      /("use strict";)|('use strict';)/,
                      `${useStrict}\n${getBytecodeLoaderBlock(chunk.fileName)}`
                    )
                  : _code
              }
              chunk.code = _code
            }
          }
        })
      )

      if (bytecodeChunkCount && !_chunks.some(ass => ass.type === 'asset' && ass.fileName === bytecodeModuleLoader)) {
        this.emitFile({
          type: 'asset',
          source: bytecodeModuleLoaderCode.join('\n') + '\n',
          name: 'Bytecode Loader File',
          fileName: bytecodeModuleLoader
        })
      }
    },
    writeBundle(_, output): void {
      if (supported) {
        const bytecodeChunkCount = Object.keys(output).filter(chunk => bytecodeChunkExtensionRE.test(chunk)).length
        this.environment.logger.info(`${colors.green(`✓`)} ${bytecodeChunkCount} chunks compiled into bytecode.`)
      }
    }
  }
}

function resolveBuildOutputs(
  outputs: Rolldown.OutputOptions | Rolldown.OutputOptions[] | undefined,
  libOptions: LibraryOptions | false
): Rolldown.OutputOptions | Rolldown.OutputOptions[] | undefined {
  if (libOptions && !Array.isArray(outputs)) {
    const libFormats = libOptions.formats || []
    return libFormats.map(format => ({ ...outputs, format }))
  }
  return outputs
}

interface ProtectStringsPluginState extends babel.PluginPass {
  opts: { protectedStrings: Set<string> }
}

function protectStringsPlugin(api: typeof babel & babel.ConfigAPI): babel.PluginObj<ProtectStringsPluginState> {
  const { types: t } = api

  function createFromCharCodeFunction(value: string): babel.types.CallExpression {
    const charCodes = Array.from(value).map(s => s.charCodeAt(0))
    const charCodeLiterals = charCodes.map(code => t.numericLiteral(code))

    // String.fromCharCode
    const memberExpression = t.memberExpression(t.identifier('String'), t.identifier('fromCharCode'))
    // String.fromCharCode(...arr)
    const callExpression = t.callExpression(memberExpression, [t.spreadElement(t.identifier('arr'))])
    // return String.fromCharCode(...arr)
    const returnStatement = t.returnStatement(callExpression)
    // function (arr) { return ... }
    const functionExpression = t.functionExpression(null, [t.identifier('arr')], t.blockStatement([returnStatement]))

    // (function(...) { ... })([x, x, x])
    return t.callExpression(functionExpression, [t.arrayExpression(charCodeLiterals)])
  }

  return {
    name: 'protect-strings-plugin',
    visitor: {
      StringLiteral(path, state) {
        // obj['property']
        if (path.parentPath.isMemberExpression({ property: path.node, computed: true })) {
          return
        }

        // { 'key': value }
        if (path.parentPath.isObjectProperty({ key: path.node, computed: false })) {
          return
        }

        // require('fs')
        if (
          path.parentPath.isCallExpression() &&
          t.isIdentifier(path.parentPath.node.callee) &&
          path.parentPath.node.callee.name === 'require' &&
          path.parentPath.node.arguments[0] === path.node
        ) {
          return
        }

        // Only CommonJS is supported, import declaration and export declaration checks are ignored

        const { value } = path.node
        if (state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value))
        }
      },
      BinaryExpression(path, state) {
        // Fold constant string concatenations (e.g. `"a" + "b"`, or a certificate split
        // across lines as `"-----BEGIN..." + "\n" + "..."`) so a protected value assembled
        // from several literals is still replaced, not just single-literal occurrences.
        if (path.node.operator !== '+') {
          return
        }

        // obj['a' + 'b']
        if (path.parentPath.isMemberExpression({ property: path.node, computed: true })) {
          return
        }

        // { ['a' + 'b']: value }
        if (path.parentPath.isObjectProperty({ key: path.node, computed: true })) {
          return
        }

        // require('a' + 'b')
        if (
          path.parentPath.isCallExpression() &&
          t.isIdentifier(path.parentPath.node.callee) &&
          path.parentPath.node.callee.name === 'require' &&
          path.parentPath.node.arguments[0] === path.node
        ) {
          return
        }

        const { confident, value } = path.evaluate()
        if (confident && typeof value === 'string' && state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value))
          path.skip()
        }
      },
      TemplateLiteral(path, state) {
        // Must be a pure static template literal
        // expressions must be empty (no ${variables})
        // quasis must have only one element (meaning the entire string is a single static part).
        if (path.node.expressions.length > 0 || path.node.quasis.length !== 1) {
          return
        }

        // Extract the raw value of the template literal
        // path.node.quasis[0].value.raw is used to get the raw string, including escape sequences
        // path.node.quasis[0].value.cooked is used to get the processed/cooked string (with escape sequences handled)
        const value = path.node.quasis[0].value.cooked
        if (value && state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value))
        }
      }
    }
  }
}
