// Bytecode compiler preload. Runs in a renderer process (sandbox:false) so the produced
// V8 code cache matches the isolate (snapshot + flag hash) of the app's runtime preload,
// which the browser/main process cache would not on Electron 42+ (V8 14.8). The compile
// result (or error) is reported back over IPC. See bin/electron-bytecode.cjs.
const fs = require('fs')
const vm = require('vm')
const v8 = require('v8')
const { ipcRenderer } = require('electron')

v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')

const COMPILE_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname']

let error = ''
try {
  const code = fs.readFileSync(process.env.ELECTRON_VITE_BYTECODE_IN, 'utf-8')
  const fn = vm.compileFunction(code, COMPILE_PARAMS, { produceCachedData: true })
  fs.writeFileSync(process.env.ELECTRON_VITE_BYTECODE_OUT, fn.cachedData)
} catch (err) {
  error = String(err && err.stack ? err.stack : err)
}

ipcRenderer.send('electron-vite:bytecode-done', error)
