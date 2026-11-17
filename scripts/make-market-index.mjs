#!/usr/bin/env node
/**
 * 生成 DSH 插件市场索引（format 1）。
 *
 * 用法（在插件仓库根的包目录里跑）：
 *   node scripts/make-market-index.mjs \
 *     --repo https://github.com/<org>/<repo> \
 *     [--commit <40位sha>] [--path <包在仓库里的相对目录>] \
 *     [--version 0.8.0] [--title 智能助理学院] \
 *     [--out market-index.json]
 *
 * 省略 --commit / --path 时从当前 git 仓库读取；--repo 省略时读 origin。
 * 生成的 JSON 放到一个 HTTPS 地址，用户在「插件市场 → 发现」里添加该 URL 即可安装。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  return stdout.trim()
}

/** git@host:org/repo.git → https://host/org/repo */
function normalizeRepo(url) {
  let text = String(url || '').trim()
  if (!text) return ''
  text = text.replace(/^git@([^:]+):/, 'https://$1/')
  text = text.replace(/^ssh:\/\/git@/, 'https://')
  text = text.replace(/\.git$/, '')
  return text
}

async function main() {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  const version = argOf('version', pkg.version)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`版本号不是精确 SemVer：${version}`)
  }
  let commit = argOf('commit')
  if (!commit) commit = await git(['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit 必须是 40 位小写 sha：${commit}`)
  let repo = normalizeRepo(argOf('repo'))
  if (!repo) repo = normalizeRepo(await git(['remote', 'get-url', 'origin']).catch(() => ''))
  if (!/^https:\/\/[^\s]+$/.test(repo)) throw new Error(`仓库地址必须是 https URL：${repo || '（空）'}`)
  let subPath = argOf('path')
  if (!subPath) {
    const prefix = await git(['rev-parse', '--show-prefix']).catch(() => '')
    subPath = prefix.replace(/\/$/, '') || '.'
  }
  const timestamp = Number(await git(['show', '-s', '--format=%ct', commit]).catch(() => Math.floor(Date.now() / 1000)))
  const title = argOf('title', pkg.title || '智能助理学院')
  const description = argOf('description', String(pkg.description || '').split('。')[0])
  const indexUrl = argOf('out', resolve(ROOT, 'market-index.json'))

  const index = {
    format: 1,
    title: { zh: argOf('indexTitle', '友联插件源'), en: argOf('indexTitleEn', 'Youlian Plugins') },
    description: { zh: '友联亨达内部 DSH 插件', en: 'Internal DSH plugins' },
    metadata: { categories: {}, labels: {}, sortKeys: {} },
    plugins: [{
      name: pkg.name,
      title: { zh: title, en: title },
      description: { zh: description, en: description },
      author: argOf('author', '友联亨达光电'),
      metadata: { keywords: ['学习', 'BOM', '课堂', '题库'], labels: [], sortKeys: {} },
      versions: [{
        version,
        publishTimestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
        source: { type: 'git', url: repo, commit, path: subPath === '.' ? undefined : subPath },
        engines: { dsh: pkg.dsh?.engines?.dsh || '>=0.2.2-rc.2' },
      }],
    }],
  }
  await writeFile(indexUrl, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  const digest = createHash('sha256').update(JSON.stringify(index)).digest('hex').slice(0, 12)
  console.log(`已生成 ${indexUrl}`)
  console.log(`  插件：${pkg.name}@${version}`)
  console.log(`  来源：git ${repo}#${commit.slice(0, 12)}${subPath === '.' ? '' : `（path ${subPath}）`}`)
  console.log(`  索引指纹：${digest}`)
  console.log('把这份 JSON 放到 HTTPS 地址，在「插件市场 → 发现」里添加该 URL 即可安装。')
}

main().catch(error => {
  console.error(`生成失败：${error?.message || error}`)
  process.exitCode = 1
})
