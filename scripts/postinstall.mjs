#!/usr/bin/env node
/**
 * dsh-doctor postinstall script.
 * 
 * Copies the self-contained CLI bundle to the npm global bin directory
 * so that `dsh-doctor` works system-wide, even if the DSH profile
 * is later deleted or corrupted.
 * 
 * Supports Windows, macOS, and Linux.
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWin = platform() === 'win32'
const isMac = platform() === 'darwin'
const isLinux = platform() === 'linux'

/**
 * Get the npm global bin directory.
 */
function getNpmGlobalBin() {
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8', stdio: 'pipe' }).trim()
    return isWin ? prefix : join(prefix, 'bin')
  } catch {
    return null
  }
}

/**
 * Check if a directory is in PATH.
 */
function isInPath(dir) {
  const pathEnv = process.env.PATH || process.env.Path || ''
  const paths = pathEnv.split(delimiter)
  // Normalize paths for comparison
  const normalizedDir = dir.replace(/\\/g, '/').toLowerCase()
  return paths.some(p => p.replace(/\\/g, '/').toLowerCase() === normalizedDir)
}

/**
 * Get shell config file path for the current user.
 */
function getShellConfig() {
  const home = homedir()
  const shell = process.env.SHELL || ''
  
  // Check for zsh first (default on macOS since Catalina)
  if (shell.includes('zsh') || existsSync(join(home, '.zshrc'))) {
    return { file: join(home, '.zshrc'), name: '.zshrc' }
  }
  // Check for bash
  if (shell.includes('bash') || existsSync(join(home, '.bashrc'))) {
    return { file: join(home, '.bashrc'), name: '.bashrc' }
  }
  // Check for fish
  if (shell.includes('fish')) {
    return { file: join(home, '.config', 'fish', 'config.fish'), name: 'fish config' }
  }
  // Default to .profile
  return { file: join(home, '.profile'), name: '.profile' }
}

/**
 * Create platform-specific wrappers.
 */
function createWrappers(globalBin, targetPath) {
  if (isWin) {
    // Windows: .cmd for Command Prompt, .ps1 for PowerShell
    writeFileSync(join(globalBin, 'dsh-doctor.cmd'), '@ECHO off\nnode "' + targetPath + '" %*\n')
    writeFileSync(join(globalBin, 'dsh-doctor.ps1'), '& node "' + targetPath + '" @args\n')
  } else {
    // Unix: executable shell script
    const binPath = join(globalBin, 'dsh-doctor')
    writeFileSync(binPath, '#!/bin/sh\nexec node "' + targetPath + '" "$@"\n')
    chmodSync(binPath, 0o755)
  }
}

function main() {
  const globalBin = getNpmGlobalBin()
  if (!globalBin) {
    console.warn('[dsh-doctor] Could not determine npm global bin directory.')
    console.warn('[dsh-doctor] Make sure npm is installed: https://nodejs.org/')
    return
  }

  // Ensure global bin dir exists
  if (!existsSync(globalBin)) {
    mkdirSync(globalBin, { recursive: true })
  }

  // Copy the self-contained bundle
  const bundleSource = join(__dirname, '..', 'lib', 'cli.bundle.js')
  
  if (existsSync(bundleSource)) {
    const bundleDest = join(globalBin, 'dsh-doctor-bundle.js')
    copyFileSync(bundleSource, bundleDest)
    createWrappers(globalBin, bundleDest)
    console.log('[dsh-doctor] Installed CLI to: ' + globalBin)
  } else {
    // Fallback: wrapper pointing to source
    const cliSource = join(__dirname, '..', 'lib', 'cli.js')
    if (existsSync(cliSource)) {
      createWrappers(globalBin, cliSource)
      console.log('[dsh-doctor] Created wrapper at: ' + globalBin)
    } else {
      console.warn('[dsh-doctor] No CLI found. Run `pnpm run build` first.')
      return
    }
  }

  // Check if global bin is in PATH
  if (!isInPath(globalBin)) {
    console.log('')
    console.log('[dsh-doctor] ⚠ ' + globalBin + ' is not in your PATH.')
    console.log('')
    
    if (isWin) {
      console.log('[dsh-doctor] To add it, run in PowerShell (as Admin):')
      console.log('  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";' + globalBin + '", [EnvironmentVariableTarget]::User)')
    } else {
      const shell = getShellConfig()
      console.log('[dsh-doctor] To add it, add this line to your ' + shell.name + ':')
      if (shell.name === 'fish config') {
        console.log('  set -gx PATH ' + globalBin + ' $PATH')
      } else {
        console.log('  export PATH="' + globalBin + ':$PATH"')
      }
      console.log('')
      console.log('[dsh-doctor] Or run:')
      console.log('  echo \'export PATH="' + globalBin + ':$PATH"\' >> ~/' + shell.name)
      console.log('  source ~/' + shell.name)
    }
    console.log('')
  } else {
    console.log('[dsh-doctor] ✓ dsh-doctor command is now available system-wide.')
  }
}

main()