import { defineConfig } from 'tsdown'

/**
 * 精简后的构建: 只剩客户端 bundle。
 *
 *   npx tsdown   → src/client/index.ts → lib/client.js
 *                  (window.__ModuleLoader__.load 浏览器 bundle,
 *                  选项数据走 remote.commands, 无自定义 Remote/无 zod 依赖)
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  // 浏览器 bundle 内联一切: 本包无平台依赖 (services 走 scope.get)
  deps: { alwaysBundle: () => true },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@yuanchilin/dsh-mailbox", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
