/**
 * 精简后的构建: 只剩客户端 bundle (宿主为纯 JS, 无需构建)。
 *
 *   1. tsdown: src/client/index.ts → lib/client.js (浏览器 bundle)
 *
 * 用法: node scripts/build.mjs   (或 npm run build -w @yuanchilin/dsh-mailbox)
 */

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command) {
  console.log(`\n$ ${command}`)
  execSync(command, { cwd: packageRoot, stdio: 'inherit' })
}

run('npx tsdown')

console.log('\nbuild done ✓')
console.log('  产物: lib/client.js  (浏览器 bundle: /mailbox 补全弹窗)')
