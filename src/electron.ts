import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import colors from 'picocolors'
import { createLogger } from 'vite'
import { loadPackageData } from './utils'

const _require = createRequire(import.meta.url)

// The Electron package name, defaults to 'electron'. A custom build (e.g.
// '@overwolf/ow-electron') can be selected via the ELECTRON_PKG_NAME env var,
// which is set from the `--electronPackage` CLI option.
const getElectronPackageName = (): string => process.env.ELECTRON_PKG_NAME || 'electron'

const ensureElectronEntryFile = (root = process.cwd()): void => {
  if (process.env.ELECTRON_ENTRY) return
  const pkg = loadPackageData()
  if (pkg) {
    if (!pkg.main) {
      throw new Error('No entry point found for electron app, please add a "main" field to package.json')
    } else {
      const entryPath = path.resolve(root, pkg.main)
      if (!fs.existsSync(entryPath)) {
        throw new Error(`No electron app entry file found: ${entryPath}`)
      }
    }
  } else {
    throw new Error('Not found: package.json')
  }
}

const getElectronMajorVer = (): string => {
  let majorVer = process.env.ELECTRON_MAJOR_VER || ''
  if (!majorVer) {
    const pkg = _require.resolve(`${getElectronPackageName()}/package.json`)
    if (fs.existsSync(pkg)) {
      const version = _require(pkg).version
      majorVer = version.split('.')[0]
      process.env.ELECTRON_MAJOR_VER = majorVer
    }
  }
  return majorVer
}

export function supportESM(): boolean {
  const majorVer = getElectronMajorVer()
  return parseInt(majorVer) >= 28
}

export function supportImportMetaPaths(): boolean {
  const majorVer = getElectronMajorVer()
  return parseInt(majorVer) >= 30
}

// Electron 42+ no longer downloads its binary via a `postinstall` script
// (supply-chain hardening). Instead the binary is fetched on first launch by
// running the package's own `install.js`, mirroring what `npx electron` does.
function installElectronBinary(electronModulePath: string): void {
  const installScript = path.join(electronModulePath, 'install.js')
  if (!fs.existsSync(installScript)) {
    throw new Error(`Electron install script not found at "${installScript}", please reinstall the electron package`)
  }
  createLogger().info(colors.green('Electron binary not found, downloading...'))
  const result = spawnSync(process.execPath, [installScript], { stdio: 'inherit', cwd: electronModulePath })
  if (result.status !== 0) {
    throw new Error('Failed to download the Electron binary')
  }
}

export function getElectronPath(): string {
  let electronExecPath = process.env.ELECTRON_EXEC_PATH || ''
  if (!electronExecPath) {
    const electronPkgName = getElectronPackageName()
    const electronModulePath = path.dirname(_require.resolve(electronPkgName))
    const pathFile = path.join(electronModulePath, 'path.txt')
    const readExecutablePath = (): string | undefined =>
      fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf-8') : undefined
    let executablePath = readExecutablePath()
    if (!executablePath && parseInt(getElectronMajorVer()) >= 42) {
      installElectronBinary(electronModulePath)
      executablePath = readExecutablePath()
    }
    if (executablePath) {
      electronExecPath = path.join(electronModulePath, 'dist', executablePath)
      process.env.ELECTRON_EXEC_PATH = electronExecPath
    } else {
      throw new Error(
        `The Electron package "${electronPkgName}" is not installed correctly, please reinstall it and try again`
      )
    }
  }
  return electronExecPath
}

export function getElectronNodeTarget(): string {
  const electronVer = getElectronMajorVer()

  const nodeVer = {
    '43': '24.17',
    '42': '24.15',
    '41': '24.14',
    '40': '24.14',
    '39': '22.20',
    '38': '22.19',
    '37': '22.16',
    '36': '22.14',
    '35': '22.14',
    '34': '20.18',
    '33': '20.18',
    '32': '20.16',
    '31': '20.14',
    '30': '20.11',
    '29': '20.9',
    '28': '18.18',
    '27': '18.17',
    '26': '18.16',
    '25': '18.15',
    '24': '18.14',
    '23': '18.12',
    '22': '16.17'
  }
  if (electronVer && parseInt(electronVer) > 10) {
    let target = nodeVer[electronVer]
    // Unknown (typically newer-than-table) versions fall back to the newest known
    // target. Integer-like keys are iterated in ascending numeric order, so the
    // newest entry is last — reverse() puts it first.
    if (!target) target = Object.values(nodeVer).reverse()[0]
    return 'node' + target
  }
  return ''
}

export function getElectronChromeTarget(): string {
  const electronVer = getElectronMajorVer()

  const chromeVer = {
    '43': '150',
    '42': '148',
    '41': '146',
    '40': '144',
    '39': '142',
    '38': '140',
    '37': '138',
    '36': '136',
    '35': '134',
    '34': '132',
    '33': '130',
    '32': '128',
    '31': '126',
    '30': '124',
    '29': '122',
    '28': '120',
    '27': '118',
    '26': '116',
    '25': '114',
    '24': '112',
    '23': '110',
    '22': '108'
  }
  if (electronVer && parseInt(electronVer) > 10) {
    let target = chromeVer[electronVer]
    // Unknown (typically newer-than-table) versions fall back to the newest known
    // target. Integer-like keys are iterated in ascending numeric order, so the
    // newest entry is last — reverse() puts it first.
    if (!target) target = Object.values(chromeVer).reverse()[0]
    return 'chrome' + target
  }
  return ''
}

export function startElectron(root: string | undefined): ChildProcess {
  ensureElectronEntryFile(root)

  const electronPath = getElectronPath()

  const isDev = process.env.NODE_ENV_ELECTRON_VITE === 'development'

  const args: string[] = process.env.ELECTRON_CLI_ARGS ? JSON.parse(process.env.ELECTRON_CLI_ARGS) : []

  if (!!process.env.REMOTE_DEBUGGING_PORT && isDev) {
    args.push(`--remote-debugging-port=${process.env.REMOTE_DEBUGGING_PORT}`)
  }

  if (!!process.env.V8_INSPECTOR_PORT && isDev) {
    args.push(`--inspect=${process.env.V8_INSPECTOR_PORT}`)
  }

  if (!!process.env.V8_INSPECTOR_BRK_PORT && isDev) {
    args.push(`--inspect-brk=${process.env.V8_INSPECTOR_BRK_PORT}`)
  }

  if (process.env.NO_SANDBOX === '1') {
    args.push('--no-sandbox')
  }

  const entry = process.env.ELECTRON_ENTRY || '.'

  const ps = spawn(electronPath, [entry].concat(args), { stdio: 'inherit' })

  currentElectronPs = ps
  installSignalForwarding()

  ps.on('close', (code, signal) => {
    // A hot reload replaces the child via a new startElectron call. Only the
    // active child should terminate the parent; otherwise restarting would
    // bring down the dev server.
    if (currentElectronPs === ps) {
      process.exit(code ?? (signal ? 1 : 0))
    }
  })

  return ps
}

// The currently running Electron child. Updated on every (re)start so a single
// set of signal handlers always targets the live process.
let currentElectronPs: ChildProcess | undefined
let signalHandlersInstalled = false

// Forward termination signals to the Electron child instead of letting the
// parent die immediately, matching electron's own CLI wrapper (electron/cli.js).
// This lets the app run its quit handlers and prevents orphaned/zombie Electron
// processes on Ctrl-C or when a parent task runner stops us. Handlers are
// installed once to avoid leaking across hot-reload restarts.
function installSignalForwarding(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      const ps = currentElectronPs
      if (ps && ps.exitCode === null && !ps.killed) {
        ps.kill(signal)
      }
    })
  }
}
