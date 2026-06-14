import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '../../../../packages/shared/openapi.json')

writeFileSync(
  outPath,
  JSON.stringify(
    {
      openapi: '3.0.0',
      info: { title: 'Project Vault', version: '0.0.1' },
      paths: {},
    },
    null,
    2
  ) + '\n'
)
