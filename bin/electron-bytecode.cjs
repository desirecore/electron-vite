const { app } = require('electron')
const vm = require('vm')
const v8 = require('v8')
const fs = require('fs')
const path = require('path')

v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')

// Compile a chunk to a V8 code cache inside the SAME process type that will load it.
// On Electron 42+ (V8 14.8) the cache is bound to a per-process-type snapshot/isolate
// checksum (header @16) and a flag hash, so a cache produced in the wrong process type is
// rejected (and force-patching the header corrupts execution). The compiler is therefore
// launched as a real Electron app (never ELECTRON_RUN_AS_NODE, whose isolate matches
// neither the main nor the renderer process):
//   - main / node chunks -> compiled here, in the browser (main) process.
//   - preload chunks      -> ELECTRON_VITE_BYTECODE_RENDERER=1: compiled in a renderer
//                            isolate by the sandbox:false preload of a hidden window.
// Input/output go through temp files (a GUI process has no usable stdio pipe).
const COMPILE_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname']
const inFile = process.env.ELECTRON_VITE_BYTECODE_IN
const outFile = process.env.ELECTRON_VITE_BYTECODE_OUT

const fail = error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  process.exitCode = 1
}

// Headless: no GPU, no visible window.
app.disableHardwareAcceleration()

if (process.env.ELECTRON_VITE_BYTECODE_RENDERER) {
  const { BrowserWindow, ipcMain } = require('electron')
  app.whenReady().then(() => {
    // Guard against a renderer that never reports back, so the build can't hang forever.
    const timer = setTimeout(() => {
      fail(new Error('bytecode compilation timed out'))
      app.quit()
    }, 60000)
    ipcMain.once('electron-vite:bytecode-done', (_event, error) => {
      clearTimeout(timer)
      if (error) {
        fail(error)
      }
      app.quit()
    })
    try {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'electron-bytecode-preload.cjs'),
          sandbox: false,
          contextIsolation: true
        }
      })
      win.loadURL('data:text/html,<!doctype html><html></html>')
    } catch (error) {
      clearTimeout(timer)
      fail(error)
      app.quit()
    }
  })
} else {
  app.whenReady().then(() => {
    try {
      const code = fs.readFileSync(inFile, 'utf-8')
      const fn = vm.compileFunction(code, COMPILE_PARAMS, { produceCachedData: true })
      fs.writeFileSync(outFile, fn.cachedData)
    } catch (error) {
      fail(error)
    }
    app.quit()
  })
}
