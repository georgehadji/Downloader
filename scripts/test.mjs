// Node 18's `--test` has no glob support and shells expand `**` differently,
// so find the test files ourselves and hand tsx an explicit list.
import {spawnSync} from 'node:child_process'
import {readdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join} from 'node:path'

const files = readdirSync('src', {recursive: true})
  .filter(file => file.endsWith('.test.ts'))
  .map(file => join('src', file))
const tsx = createRequire(import.meta.url).resolve('tsx/cli')

const {status} = spawnSync(process.execPath, [tsx, '--test', ...files], {stdio: 'inherit'})
process.exit(status ?? 1)
