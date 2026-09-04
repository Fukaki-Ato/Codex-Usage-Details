const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const testDirectory = path.join(root, 'tests')
const testFiles = fs.readdirSync(testDirectory)
  .filter((file) => file.endsWith('.test.cjs'))
  .sort()
  .map((file) => path.join(testDirectory, file))

if (!testFiles.length) {
  console.error('No test files were found.')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
