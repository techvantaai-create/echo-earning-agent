// Submission adapters.
//
// The state machine must not know what a bounty platform wants. `READY_TO_SUBMIT -> SUBMITTED` means
// "an actual submission happened", but WHAT that submission consists of is a property of the rail, not
// of the pipeline: a GitHub bounty wants a branch and a PR, Algora wants that plus a claim line in the
// PR body, Superteam wants an API call and no PR at all. So each rail declares its own requirements and
// owns its own execution; orders.mjs only asks.
//
// Every adapter exposes the same four things:
//   requirements(order) -> string[]        what this rail needs, for display and for the order record
//   preflight(order, ws) -> {ok, checks}   READ-ONLY capability check; never changes anything
//   plan(order, ws, st)  -> object         exactly what a real submission would do
//   execute(order, ws, opts) -> result     the only place an external side effect may occur
import { execFileSync } from 'node:child_process'

// Anything we ever store or print goes through this first. Tokens can surface in git/gh error output,
// and a leaked credential in work-orders.json would be committed to a public repo by the next cron tick.
export function redact(text) {
  let out = String(text ?? '')
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SUPERTEAM_API_KEY', 'DEALWORK_API_KEY', 'TOKU_API_KEY']) {
    const v = process.env[k]
    if (v && v.length >= 4) out = out.split(v).join(`[REDACTED:${k}]`)
  }
  return out
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED:gh-token]')
    .replace(/\bak_[A-Za-z0-9]{8,}/g, '[REDACTED:api-key]')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[REDACTED]')
}

// Single seam so tests can drive every adapter against local mocks and never touch the network.
let runner = null
export function __setRunner(fn) { const prev = runner; runner = fn; return prev }
function exec(cmd, args, cwd, opts) { return (runner ?? run)(cmd, args, cwd, opts) }

function run(cmd, args, cwd, { timeout = 120000 } = {}) {
  try {
    return { ok: true, code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (e) {
    return { ok: false, code: e.status ?? -1, out: (String(e.stdout ?? '') + String(e.stderr ?? '')).trim().slice(-800) }
  }
}

const ghRepo = (url) => (String(url).match(/github\.com\/([^/]+)\/([^/.]+)/) ?? []).slice(1, 3).join('/') || null
const issueNum = (url) => { const m = String(url).match(/\/issues\/(\d+)/); return m ? Number(m[1]) : null }

// ── GitHub fork provisioning (CAPABILITY, not a submission adapter) ──────────────────────────────
// Creating a fork is a write on the user's GitHub account, so it is its own explicitly gated action and
// is never a side effect of start/prepare-submit/submit. Those paths report FORK_REQUIRED instead.
// This object is the ONLY place in the codebase that may create a fork.
export const githubFork = {
  name: 'github-fork',
  requirements: () => ['authenticated_github_session', 'writable_fork_target'],

  // Read-only. Establishes identity, whether a fork already exists, and whether it is ours to write to.
  detect(o) {
    const src = ghRepo(o?.source_url) ?? ghRepo(o?.repo_url)
    if (!src) return { found: false, status: 'NO_SOURCE', error: 'cannot parse owner/repo from the order' }
    const me = exec('gh', ['api', 'user', '--jq', '.login'], process.cwd())
    if (!me.ok) return { found: false, status: 'NO_AUTH', source: src, error: redact(me.out) }
    const login = me.out.trim()
    const name = src.split('/')[1]
    const v = exec('gh', ['repo', 'view', `${login}/${name}`, '--json', 'name,owner,url,isFork,parent,viewerPermission'], process.cwd())
    if (!v.ok) return { found: false, status: 'FORK_REQUIRED', source: src, login }
    let j
    try { j = JSON.parse(v.out) } catch { return { found: false, status: 'UNCERTAIN', source: src, login, error: 'unparseable repo response' } }
    const parent = j.parent?.nameWithOwner ?? j.parent?.owner?.login ? `${j.parent?.owner?.login}/${j.parent?.name}` : null
    // A same-named repo that is not a fork of THIS source is a conflict, not our fork.
    if (!j.isFork || (parent && parent.toLowerCase() !== src.toLowerCase())) {
      return { found: false, status: 'FORK_CONFLICT', source: src, login, detail: `${login}/${name} exists but is not a fork of ${src}` }
    }
    const writable = /WRITE|ADMIN|MAINTAIN/i.test(String(j.viewerPermission ?? ''))
    return {
      found: true, status: writable ? 'FORK_PRESENT' : 'FORK_NOT_WRITABLE', source: src, login, writable,
      fork: { owner: login, repo: name, url: j.url ?? `https://github.com/${login}/${name}`, source_repo: src },
    }
  },

  preflight(o, ws) {
    const src = ghRepo(o?.source_url) ?? ghRepo(o?.repo_url)
    const d = this.detect(o)
    const submitted = ['SUBMITTED', 'ACCEPTED_WORK', 'PAYMENT_PENDING', 'PAID'].includes(o?.current_state)
    const partial = Boolean(o?.submission_result && o.submission_result.submitted === false)
    const wsRepo = ws?.repo_url ? ghRepo(ws.repo_url) : null
    const checks = [
      { check: 'source repository parsed', ok: Boolean(src), detail: src ?? 'unparseable' },
      { check: 'source matches the work order', ok: !wsRepo || !src || wsRepo.toLowerCase() === src.toLowerCase(), detail: wsRepo ? `${wsRepo} vs ${src}` : 'no workspace repo to compare' },
      { check: 'authenticated GitHub identity', ok: d.status !== 'NO_AUTH', detail: d.login ?? 'gh auth login required' },
      { check: 'target account known', ok: Boolean(d.login), detail: d.login ?? 'unknown' },
      { check: 'no conflicting repository', ok: d.status !== 'FORK_CONFLICT', detail: d.detail ?? 'clear' },
      { check: 'order not already submitted', ok: !submitted, detail: o?.current_state ?? 'n/a' },
      { check: 'no unresolved submission attempt', ok: !partial, detail: partial ? 'a previous submission failed part-way; resolve it first' : 'clean' },
    ]
    const ok = checks.every((c) => c.ok)
    return { ok, status: d.status, already_present: d.found, fork: d.fork ?? null, checks }
  },

  plan(o) {
    const src = ghRepo(o?.source_url) ?? ghRepo(o?.repo_url)
    const d = this.detect(o)
    return {
      capability: 'github-fork', requirements: this.requirements(o), source_repo: src,
      target_account: d.login ?? '(unknown — gh auth required)',
      expected_fork: d.login && src ? `${d.login}/${src.split('/')[1]}` : null,
      already_present: d.found, status: d.status,
      actions: d.found ? ['(none — fork already exists)'] : [`gh repo fork ${src} --clone=false --remote=false`],
      creates_credentials: false, moves_money: false, work_order_id: o?.work_order_id ?? null,
    }
  },

  // THE SINGLE EXTERNAL WRITE. Nothing else in the codebase may create a fork.
  execute(o, { dry = true } = {}) {
    if (dry) throw new Error('fork execute called without an explicit execution opt-in')
    const before = this.detect(o)
    if (before.found) return { created: false, status: 'FORK_PRESENT', reason: 'fork already exists', fork: before.fork }
    if (before.status === 'FORK_CONFLICT') return { created: false, status: 'FORK_CONFLICT', error: before.detail }
    if (before.status === 'NO_AUTH' || !before.source) return { created: false, status: before.status, error: redact(before.error ?? 'preconditions not met') }
    const r = exec('gh', ['repo', 'fork', before.source, '--clone=false', '--remote=false'], process.cwd())
    if (!r.ok) return { created: false, status: 'FAILED', error: redact(r.out) }
    const after = this.detect(o)
    if (!after.found) {
      // Deliberately no retry: a fork may have been created despite an unreadable response, and forking
      // again could produce a second repo. A human resolves this.
      return { created: false, status: 'UNCERTAIN', error: 'fork reported success but could not be read back; NOT retrying automatically' }
    }
    return { created: true, status: 'FORK_PRESENT', fork: after.fork }
  },
}

export const CAPABILITIES = { 'github-fork': githubFork }

// ── GitHub pull request ───────────────────────────────────────────────────────────────────────────
const githubPr = {
  name: 'github-pr',
  requirements: () => ['push_branch', 'open_pull_request'],
  preflight(o, ws) {
    const checks = []
    const repo = ghRepo(o.source_url) ?? ghRepo(ws?.repo_url)
    checks.push({ check: 'target repo resolved', ok: Boolean(repo), detail: repo ?? 'could not parse owner/repo' })
    checks.push({ check: 'workspace present', ok: Boolean(ws?.path), detail: ws?.path ?? 'none' })
    checks.push({ check: 'branch recorded', ok: Boolean(ws?.branch), detail: ws?.branch ?? 'none' })
    const gh = exec('gh', ['auth', 'status'], ws?.path ?? process.cwd())
    checks.push({ check: 'gh CLI authenticated', ok: gh.ok, detail: gh.ok ? 'authenticated' : 'gh auth login required — submission acts as the authenticated user' })
    // Pushing needs somewhere writable. Fork detection is delegated to the fork capability so GitHub
    // calls stay in one place; a recorded fork on the order is trusted first.
    const recorded = o?.fork?.url ? { found: true, status: 'FORK_PRESENT', fork: o.fork } : githubFork.detect(o)
    checks.push({ check: 'writable fork exists', ok: recorded.found, detail: recorded.found ? `${recorded.fork.owner}/${recorded.fork.repo}` : 'FORK_REQUIRED — run provision-fork (separate approved action)' })
    return { ok: checks.every((c) => c.ok), status: recorded.found ? 'READY' : 'FORK_REQUIRED', fork: recorded.fork ?? null, checks }
  },
  plan(o, ws, st) {
    const repo = ghRepo(o.source_url) ?? ghRepo(ws?.repo_url)
    return {
      adapter: 'github-pr', requirements: this.requirements(o), target_repo: repo,
      branch: ws?.branch, base_branch: ws?.base_branch, base_commit: ws?.base_commit, head: st?.head,
      diffstat: st?.diffstat, commits: st?.commits,
      pr_title: `fix: ${o.title ?? o.work_order_id}`,
      pr_body: `Fixes ${o.source_url ?? o.work_order_id}\n\n## Acceptance criteria\n${o.acceptance_criteria ?? '(none recorded)'}\n\n## Local verification\n${o.verification?.passed ? 'passed' : 'NOT PASSED'}`,
      actions: ['git push <fork> <branch>', 'gh pr create --repo <target> --head <branch>'],
    }
  },
  execute(o, ws, { dry = true } = {}) {
    if (dry) throw new Error('execute called without a real-submission opt-in')
    const repo = ghRepo(o.source_url) ?? ghRepo(ws?.repo_url)
    const push = exec('git', ['push', '--set-upstream', 'origin', ws.branch], ws.path)
    if (!push.ok) return { submitted: false, stage: 'push_branch', error: push.out }
    const p = this.plan(o, ws, null)
    const pr = exec('gh', ['pr', 'create', '--repo', repo, '--head', ws.branch, '--base', ws.base_branch, '--title', p.pr_title, '--body', p.pr_body], ws.path)
    if (!pr.ok) return { submitted: false, stage: 'open_pull_request', error: pr.out }
    return { submitted: true, url: pr.out.split('\n').pop(), actions_performed: ['push_branch', 'open_pull_request'] }
  },
}

// ── Algora: a GitHub PR plus the claim line the bounty bot looks for ──────────────────────────────
const algora = {
  name: 'algora',
  requirements: () => ['push_branch', 'open_pull_request', 'claim_line_in_pr_body'],
  preflight(o, ws) {
    const base = githubPr.preflight(o, ws)
    const n = issueNum(o.source_url)
    base.checks.push({ check: 'bounty issue number parsed', ok: Boolean(n), detail: n ? `#${n}` : 'cannot build the /claim line without it' })
    // spread the base result so status/fork survive — rebuilding the object here silently dropped
    // FORK_REQUIRED, which is the one signal callers act on.
    return { ...base, ok: base.checks.every((c) => c.ok), checks: base.checks }
  },
  plan(o, ws, st) {
    const p = githubPr.plan.call(githubPr, o, ws, st)
    const n = issueNum(o.source_url)
    p.adapter = 'algora'
    p.requirements = this.requirements(o)
    p.claim_line = n ? `/claim #${n}` : null
    // Algora reads the claim out of the PR body; it is not a separate comment.
    p.pr_body = `${p.pr_body}\n\n${p.claim_line ?? ''}`.trimEnd()
    p.actions = [...p.actions, 'claim line embedded in PR body (no separate comment posted)']
    return p
  },
  execute(o, ws, opts) {
    const p = this.plan(o, ws, null)
    if (!p.claim_line) return { submitted: false, stage: 'claim_line_in_pr_body', error: 'no issue number' }
    return githubPr.execute.call({ ...githubPr, plan: () => p }, o, ws, opts)
  },
}

// ── Superteam: API submission, no PR. Present to prove the pipeline is not Algora-shaped. ─────────
const superteam = {
  name: 'superteam',
  requirements: () => ['authenticated_api_submission', 'listing_slug', 'submission_payload'],
  preflight(o) {
    const checks = [
      { check: 'listing slug resolved', ok: Boolean(String(o.work_order_id).startsWith('superteam:')), detail: o.work_order_id },
      { check: 'SUPERTEAM_API_KEY present in env', ok: Boolean(process.env.SUPERTEAM_API_KEY), detail: 'key lives in Actions secrets; not readable locally' },
    ]
    return { ok: checks.every((c) => c.ok), checks }
  },
  plan(o) {
    return {
      adapter: 'superteam', requirements: this.requirements(o), target: o.source_url,
      actions: ['POST submission to the Superteam agent API'],
      note: 'no branch, no PR — this rail does not use GitHub at all',
    }
  },
  execute() { throw new Error('superteam submission adapter is not implemented') },
}

export const ADAPTERS = { 'github-pr': githubPr, algora, superteam }

// Pick by explicit override, else by the order's source. Unknown sources fail loudly rather than
// silently defaulting to GitHub — a wrong adapter would submit the wrong thing to the wrong place.
export function adapterFor(o) {
  const key = o?.submission_adapter ?? o?.source
  const a = ADAPTERS[key] ?? (key === 'github' ? ADAPTERS['github-pr'] : null)
  if (!a) throw new Error(`no submission adapter for source "${key}" — register one in adapters.mjs`)
  return a
}
export function requirementsFor(o) { return adapterFor(o).requirements(o) }
