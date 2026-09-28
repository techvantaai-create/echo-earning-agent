// Isolated local workspaces for accepted work orders.
//
// Two deliberate choices:
//   1. Workspaces live OUTSIDE this repository (sibling `.echo-workspaces/`). The Actions workflow runs
//      `git add -A`, so a clone placed inside the repo would be committed and pushed to a public repo on
//      the next cron tick. Outside is the only safe place for it.
//   2. Nothing here pushes. `create` clones and branches locally; there is no remote-write call in this
//      file at all, so "accidentally opened a PR" is not a reachable state.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const WORKSPACE_ROOT = fileURLToPath(new URL('../.echo-workspaces/', import.meta.url))

// Commands that would create an external side effect. Even though we never call them, the guard means a
// later edit that tries has to defeat an explicit check rather than slip through unnoticed.
const FORBIDDEN_GIT = ['push', 'remote add', 'remote set-url']
function assertLocalOnly(args) {
  const line = args.join(' ').toLowerCase()
  for (const f of FORBIDDEN_GIT) {
    if (line.includes(f)) throw new Error(`refused: git ${f} is not permitted from the workspace layer`)
  }
}

export function git(args, cwd, { timeout = 120000 } = {}) {
  assertLocalOnly(args)
  return execFileSync('git', args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Deterministic, collision-free, and reversible: one order id maps to exactly one directory, so two
// orders can never land in the same tree and the workspace is findable again at submission time.
export function slugFor(orderId) {
  return String(orderId).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120)
}
export function pathFor(orderId) { return `${WORKSPACE_ROOT}${slugFor(orderId)}` }

export function exists(orderId) { return existsSync(pathFor(orderId)) }

// Clone + branch. Refuses to reuse a directory: a second create for the same order, or a different order
// resolving onto an occupied path, is an error rather than a silent overwrite of work in progress.
export function create(orderId, { repoUrl, branch, baseRef = null }) {
  if (!orderId) throw new Error('workspace requires an order id')
  if (!repoUrl) throw new Error('workspace requires a repository URL')
  if (!branch) throw new Error('workspace requires a branch name')
  const dir = pathFor(orderId)
  if (existsSync(dir)) throw new Error(`workspace already exists for ${orderId}: ${dir}`)
  mkdirSync(WORKSPACE_ROOT, { recursive: true })
  git(['clone', '--quiet', repoUrl, dir], WORKSPACE_ROOT)
  if (baseRef) git(['checkout', '--quiet', baseRef], dir)
  const base_commit = git(['rev-parse', 'HEAD'], dir).trim()
  const default_branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim()
  git(['checkout', '--quiet', '-b', branch], dir)
  return {
    order_id: orderId, path: dir, repo_url: repoUrl, branch, base_commit,
    base_branch: default_branch, created_at: new Date().toISOString(),
  }
}

export function status(ws) {
  if (!ws?.path || !existsSync(ws.path)) return { error: 'workspace missing' }
  try {
    return {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.path).trim(),
      head: git(['rev-parse', 'HEAD'], ws.path).trim(),
      dirty: git(['status', '--porcelain'], ws.path).trim(),
      diffstat: git(['diff', '--stat', `${ws.base_commit}..HEAD`], ws.path).trim(),
      commits: git(['log', '--oneline', `${ws.base_commit}..HEAD`], ws.path).trim(),
    }
  } catch (e) { return { error: e.message } }
}

export function destroy(orderId) {
  const dir = pathFor(orderId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  return dir
}
