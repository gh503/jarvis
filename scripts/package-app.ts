#!/usr/bin/env node
/**
 * `npm run package` — build a portable bundle you can hand to someone who does
 * not have Node installed.
 *
 * What it produces: dist/jarvis-<os>-<arch>.tar.gz containing the source, the
 * `ws` dependency, a copy of the Node runtime that is running this script, and
 * a launcher that starts Jarvis and opens the app window.
 *
 * What it deliberately does not do: signed .exe/.msi/.dmg/.AppImage installers.
 * Those need a platform toolchain and a code-signing certificate; they are not
 * something this repository can fake. The portable bundle plus "install as app"
 * in the browser covers the same need without a signing key, and the PWA path
 * works on phones too.
 *
 * Cross-compilation is not supported: the Node binary must match the target OS.
 * Run this on each OS you want to ship.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const target = (args.find(item => item.startsWith('--target='))?.split('=')[1] ?? process.platform)
const arch = process.arch
const name = `jarvis-${target}-${arch}`
const outDir = join(root, 'dist')
const stage = join(outDir, name)
const archiveBase = join(outDir, name)

function run(command: string, argv: string[], cwd = root): boolean {
  const result = spawnSync(command, argv, { cwd, stdio: 'inherit' })
  return result.status === 0
}

async function copyRequired(from: string, to: string): Promise<void> {
  if (!existsSync(from)) throw new Error(`缺少 ${from}，无法打包`)
  await cp(from, to, { recursive: true })
}

async function main(): Promise<void> {
  if (target !== process.platform) {
    console.error(`不能从 ${process.platform} 打包 ${target}：Node 运行时必须与目标系统一致。请在那台机器上运行 npm run package。`)
    process.exitCode = 1
    return
  }
  console.log(`打包 ${name} …`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  for (const entry of ['src', 'web', 'scripts', 'node_modules', 'package.json', 'README.md', 'docs']) {
    await copyRequired(join(root, entry), join(stage, entry))
  }
  // Keep the bundle small and free of local state.
  for (const junk of ['dist', 'data', 'test', '.git']) {
    await rm(join(stage, junk), { recursive: true, force: true })
  }

  const runtimeDir = join(stage, 'runtime')
  await mkdir(runtimeDir, { recursive: true })
  const binary = process.platform === 'win32' ? 'node.exe' : 'node'
  await cp(process.execPath, join(runtimeDir, binary))

  if (process.platform === 'win32') {
    await writeFile(join(stage, 'Jarvis.cmd'), [
      '@echo off',
      'setlocal',
      'set "HERE=%~dp0"',
      '"%HERE%runtime\\node.exe" --experimental-transform-types "%HERE%scripts\\app.ts" %*',
      '',
    ].join('\r\n'))
  } else {
    await writeFile(join(stage, 'jarvis'), [
      '#!/bin/sh',
      'set -e',
      'HERE=$(cd "$(dirname "$0")" && pwd)',
      'exec "$HERE/runtime/node" --experimental-transform-types "$HERE/scripts/app.ts" "$@"',
      '',
    ].join('\n'), { mode: 0o755 })
  }

  await writeFile(join(stage, '双击这里.txt'), [
    'Jarvis 便携版',
    '',
    process.platform === 'win32' ? '双击 Jarvis.cmd 启动。' : '双击 jarvis（或在终端运行 ./jarvis）启动。',
    '第一次启动会在数据目录里建库，大约需要 20 秒，然后会自动打开应用窗口。',
    '',
    '浏览器里也可以直接用：启动后访问 http://127.0.0.1:3081/',
    '手机上用：电脑和手机连同一个 Wi-Fi，先看 docs/getting-started.md 的“手机上用”一节。',
    '',
    '模型服务：首次打开后点右上角“设置 → 模型 → 打开供应商指南”，',
    '按三步填一个 API Key；不想花钱就装 Ollama 用本机模型。',
    '',
    `包含的运行时：Node ${process.version}（${process.platform}/${process.arch}）`,
    '这个目录可以整个拷到 U 盘或另一台同系统的电脑上，不需要安装。',
  ].join('\n'))

  const zipAvailable = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0
  let archive = `${archiveBase}.tar.gz`
  if (zipAvailable) {
    archive = `${archiveBase}.zip`
    if (!run('zip', ['-qr', archive, name], outDir)) throw new Error('zip 失败')
  } else if (!run('tar', ['-czf', archive, '-C', outDir, name])) {
    throw new Error('tar 失败')
  }

  const info = await stat(archive)
  const mb = (info.size / 1024 / 1024).toFixed(1)
  console.log(`\n完成：${archive}（${mb} MB）`)
  console.log('解压后运行 launcher 即可；不需要安装 Node。')
  console.log('提示：想做成系统级安装包（.msi/.dmg/AppImage）需要签名证书，本仓库不提供。')
  await rm(stage, { recursive: true, force: true })
}

main().catch(error => {
  console.error('打包失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
