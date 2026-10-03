// 领域逻辑验证运行器：用 esbuild JS API 把 TS 脚本（含 @ 别名）打成 CJS 再执行。
// 用法：node scripts/run-verify.cjs
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
esbuild
  .build({
    entryPoints: [path.join(root, 'scripts/verify-batch.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@': path.join(root, 'src') },
    outfile: path.join(root, 'node_modules/.cache/verify-batch.cjs'),
    logLevel: 'silent',
  })
  .then(() => {
    require(path.join(root, 'node_modules/.cache/verify-batch.cjs'))
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
