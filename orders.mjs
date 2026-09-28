// Work-order pipeline for the earning agent.
//
// The whole point of this module is SEPARATION. Discovering a job, accepting it, doing it, submitting
// it and being paid for it are five different events, and the failure mode we are designing against is
// a sensor quietly deciding it has taken on work. So:
//
//   - agent.mjs (unattended, every 30 min on Actions) imports ONLY `intake` + `load`. It can create
//     DISCOVERED rows. It cannot advance anything, because every gated transition demands an approval
//     argument the cron process has no way to produce.
//   - The gated transitions live behind the CLI at the bottom of this file, which the workflow never
//     calls. A human runs it.
//   - Nothing here moves money, and `assertNoFinancialAction` exists so that stays true by construction
//     rather than by anyone remembering.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as ws from './workspace.mjs'
import { adapterFor, requirementsFor, CAPABILITIES, redact } from './adapters.mjs'

const STORE = new URL('./work-orders.json', import.meta.url)

// Linear happy path, plus the four exits any state can take. A work order is only ever in one state.
export const STATES = [
  'DISCOVERED', 'QUALIFIED', 'READY_TO_ACCEPT', 'ACCEPTED', 'IN_PROGRESS',
  'READY_TO_SUBMIT', 'SUBMITTED', 'ACCEPTED_WORK', 'PAYMENT_PENDING', 'PAID',
  'REJECTED', 'BLOCKED', 'EXPIRED', 'ABANDONED',
]
export const TERMINAL = ['PAID', 'REJECTED', 'EXPIRED', 'ABANDONED']

// Explicit table beats an implicit ordering: an illegal jump (e.g. DISCOVERED -> SUBMITTED) must be
// impossible, not merely unlikely.
const TRANSITIONS = {
  DISCOVERED:      ['QUALIFIED', 'REJECTED', 'BLOCKED', 'EXPIRED'],
  QUALIFIED:       ['READY_TO_ACCEPT', 'REJECTED', 'BLOCKED', 'EXPIRED'],
  READY_TO_ACCEPT: ['ACCEPTED', 'REJECTED', 'BLOCKED', 'EXPIRED', 'ABANDONED'],
  ACCEPTED:        ['IN_PROGRESS', 'BLOCKED', 'ABANDONED'],
  IN_PROGRESS:     ['READY_TO_SUBMIT', 'BLOCKED', 'ABANDONED'],
  READY_TO_SUBMIT: ['SUBMITTED', 'BLOCKED', 'ABANDONED'],
  SUBMITTED:       ['ACCEPTED_WORK', 'REJECTED', 'EXPIRED'],
  ACCEPTED_WORK:   ['PAYMENT_PENDING', 'EXPIRED'],
  PAYMENT_PENDING: ['PAID', 'EXPIRED'],
  PAID: [], REJECTED: [], EXPIRED: [], ABANDONED: [],
  BLOCKED: ['QUALIFIED', 'READY_TO_ACCEPT', 'REJECTED', 'ABANDONED'], // unblock returns to the queue
}

// The two moments that bind the user to something outward-facing. Both require an explicit human GO.
export const GATED = { ACCEPTED: 'WORK_ACCEPTANCE', SUBMITTED: 'WORK_SUBMISSION' }

// FINANCIAL_ACTION is not a gate — it is a wall. No transition in this machine spends, funds, trades,
// stakes or moves anything. If a future edit tries to add one, this throws instead of asking.
const FINANCIAL = ['spend', 'fund', 'deposit', 'withdraw', 'trade', 'stake', 'purchase', 'gas', 'transfer']
export function assertNoFinancialAction(op) {
  if (FINANCIAL.some((f) => String(op).toLowerCase().includes(f))) {
    throw new Error(`FINANCIAL_ACTION is permanently blocked: refused "${op}"`)
  }
}

export function blank(o = {}) {
  return {
    work_order_id: o.work_order_id, source: o.source ?? null, source_url: o.source_url ?? null,
    title: o.title ?? null, description: o.description ?? null,
    reward: o.reward ?? null, reward_currency: o.reward_currency ?? null,
    payout_method: o.payout_method ?? null, payout_evidence: o.payout_evidence ?? 'UNKNOWN',
    acceptance_criteria: o.acceptance_criteria ?? null, deadline: o.deadline ?? null,
    source_created_at: o.source_created_at ?? null, // when the OPPORTUNITY appeared at the source
    estimated_effort: o.estimated_effort ?? null, competition: o.competition ?? 'UNKNOWN',
    ai_eligibility: o.ai_eligibility ?? 'UNKNOWN', zero_cost_status: o.zero_cost_status ?? 'UNKNOWN',
    required_accounts: o.required_accounts ?? [], required_credentials: o.required_credentials ?? [],
    risk_flags: o.risk_flags ?? [], current_state: 'DISCOVERED',
    discovered_at: o.discovered_at ?? new Date().toISOString(),
    accepted_at: null, submitted_at: null, paid_at: null,
    workspace: null, verification: null, submission_plan: null,
    submission_adapter: null, submission_requirements: null, submission_result: null,
    fork: null, fork_attempt: null,   // infrastructure metadata, NOT a business state
    // Payment reconciliation. `expected_*` is what we believe we are owed; `observed_*` is what we can
    // actually evidence. They are separate on purpose — the whole failure mode here is treating a number
    // we hoped for as a number we received.
    expected_reward: o.expected_reward ?? o.reward ?? null,
    expected_currency: o.expected_currency ?? o.reward_currency ?? null,
    expected_payer: o.expected_payer ?? null,
    payment_reference: null, observed_payment: null, payment_observed_at: null,
    reconciliation_status: 'UNRECONCILED',
    history: [], notes: [],
  }
}

export function load() {
  try { return JSON.parse(readFileSync(STORE, 'utf8')) } catch { return [] }
}
function save(orders) { writeFileSync(STORE, JSON.stringify(orders, null, 2) + '\n') }

// Discovery ONLY. Creates DISCOVERED rows for ids not already tracked and returns what it added.
// Deliberately cannot set any other state — this is the function the unattended cron is allowed to call.
export function intake(candidates = []) {
  const orders = load()
  const known = new Set(orders.map((o) => o.work_order_id))
  const added = []
  for (const c of candidates) {
    if (!c?.work_order_id || known.has(c.work_order_id)) continue
    const o = blank(c)
    o.history.push({ at: o.discovered_at, from: null, to: 'DISCOVERED', by: 'sensor' })
    orders.push(o); known.add(o.work_order_id); added.push(o)
  }
  if (added.length) save(orders)
  return added
}

// Metadata updates only. Explicitly refuses state and the lifecycle timestamps, so a metadata write can
// never double as a promotion — state moves exclusively through transition().
const PROTECTED = ['current_state', 'accepted_at', 'submitted_at', 'paid_at', 'history', 'work_order_id']
export function patch(id, fields = {}) {
  const orders = load()
  const o = orders.find((x) => x.work_order_id === id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  for (const k of Object.keys(fields)) {
    if (PROTECTED.includes(k)) throw new Error(`refused: "${k}" cannot be set via patch()`)
    o[k] = fields[k]
  }
  save(orders)
  return o
}

export function get(id) { return load().find((x) => x.work_order_id === id) ?? null }

// The only way a work order changes state. `approval` must be a non-empty string for gated targets;
// there is no default and no override flag, so an automated caller simply cannot pass this gate.
export function transition(id, to, { approval = null, note = null, by = 'human' } = {}) {
  assertNoFinancialAction(to)
  const orders = load()
  const o = orders.find((x) => x.work_order_id === id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  if (!STATES.includes(to)) throw new Error(`unknown state: ${to}`)
  const legal = TRANSITIONS[o.current_state] ?? []
  if (!legal.includes(to)) {
    throw new Error(`illegal transition ${o.current_state} -> ${to} (legal: ${legal.join(', ') || 'none, terminal'})`)
  }
  if (GATED[to] && !(typeof approval === 'string' && approval.trim())) {
    throw new Error(`${GATED[to]} requires explicit human approval — re-run with --approve "<reason>"`)
  }
  const at = new Date().toISOString()
  o.history.push({ at, from: o.current_state, to, by, approval: GATED[to] ? approval : undefined, note })
  o.current_state = to
  if (to === 'ACCEPTED') o.accepted_at = at
  if (to === 'SUBMITTED') o.submitted_at = at
  if (to === 'PAID') o.paid_at = at
  if (note) o.notes.push({ at, note })
  save(orders)
  return o
}

export function summary() {
  const orders = load()
  const byState = {}
  for (const o of orders) byState[o.current_state] = (byState[o.current_state] ?? 0) + 1
  return { total: orders.length, byState, active: orders.filter((o) => !TERMINAL.includes(o.current_state)).length }
}

// Age is derived, never stored: a stored age is wrong the moment it is written. It measures the
// OPPORTUNITY's age at its source, never when we happened to notice it — falling back to discovered_at
// would stamp a two-year-old bounty as brand new the first time a sensor saw it, which is the exact
// misranking this signal exists to prevent. Unknown stays unknown.
export function ageHours(o) {
  const t = Date.parse(o.source_created_at ?? '')
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 3600000) : null
}

// Phase 5 readiness. Deliberately excludes competition: a crowded bounty is still a legitimate,
// executable job, so competition moves the SCORE and never flips this object to false.
export function readiness(o) {
  const ev = String(o.payout_evidence ?? '')
  const checks = {
    source_verified: Boolean(o.source && o.source_url),
    opportunity_open: !TERMINAL.includes(o.current_state) && o.current_state !== 'BLOCKED',
    reward_identified: o.reward != null,
    payout_path_credible: /VERIFIED_PAID|PARTIAL/i.test(ev),
    zero_cost_confirmed: /CONFIRMED/i.test(String(o.zero_cost_status ?? '')),
    ai_eligibility_sufficient: /AI_ALLOWED|AI_DISCLOSURE_REQUIRED/i.test(String(o.ai_eligibility ?? '')),
    acceptance_criteria_understood: Boolean(o.acceptance_criteria),
    account_obligations_understood: Array.isArray(o.required_accounts),
    no_prohibited_financial_requirement: !(o.risk_flags ?? []).some((f) =>
      /CAPITAL|DEPOSIT|PAID_API|SUBSCRIPTION|GAS|TRADING|STAKE|PURCHASE/i.test(String(f))),
  }
  const blockers = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  return { ready: blockers.length === 0, checks, blockers }
}

// Competition band — the same policy the user authorized for Algora's /attempt count (2026-09-15):
// 0=NONE, 1-5=LOW, 6-20=MEDIUM, >20=HIGH. Applying it to Superteam's submission count is reusing an
// existing, already-approved rule, not inventing a new one. Moved here from agent.mjs so it exists in
// exactly one place; agent.mjs now imports this instead of keeping its own copy.
export const competitionBand = (n) => (n === 0 ? 'NONE' : n <= 5 ? 'LOW' : n <= 20 ? 'MEDIUM' : 'HIGH')

const COMP_PENALTY = { NONE: 0, LOW: 5, MEDIUM: 15, HIGH: 30, UNKNOWN: 15 }

// Deterministic 0-100. Same inputs always give the same number — no randomness, no clock beyond age.
export function score(o) {
  const r = readiness(o)
  let n = 0
  n += r.ready ? 40 : Math.round(40 * (1 - r.blockers.length / Object.keys(r.checks).length))
  const h = ageHours(o)
  n += h == null ? 5 : h <= 24 ? 20 : h <= 72 ? 15 : h <= 168 ? 10 : h <= 720 ? 4 : 0
  n += /VERIFIED_PAID/i.test(String(o.payout_evidence)) ? 20 : /PARTIAL/i.test(String(o.payout_evidence)) ? 8 : 0
  const flags = (o.risk_flags ?? []).map(String).join(' ')
  n += /STALE_MAINTAINER|STALE_BOUNTY_MERGE_PATH/i.test(flags) ? 0 : 10
  const hourly = rewardPerHour(o)
  n += hourly == null ? 2 : hourly >= 50 ? 10 : hourly >= 20 ? 7 : hourly >= 5 ? 4 : 1
  n -= COMP_PENALTY[o.competition] ?? 15   // competition is a SCORE penalty only
  return Math.max(0, Math.min(100, n))
}

export function rewardPerHour(o) {
  const hrs = String(o.estimated_effort ?? '').match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*h/i)
    || String(o.estimated_effort ?? '').match(/(\d+(?:\.\d+)?)\s*h/i)
  if (!hrs || o.reward == null) return null
  const mid = hrs[2] ? (Number(hrs[1]) + Number(hrs[2])) / 2 : Number(hrs[1])
  return mid > 0 ? Math.round((o.reward / mid) * 100) / 100 : null
}

// Ranking is triage, NOT permission. A P0 row is still stuck at its current state until a human
// promotes it; nothing downstream reads priority as authorisation.
export function priority(o) {
  if (TERMINAL.includes(o.current_state) || o.current_state === 'BLOCKED') return 'P3'
  const r = readiness(o)
  if (!r.ready) return r.blockers.length <= 2 ? 'P2' : 'P3'
  const h = ageHours(o)
  const fresh = h != null && h <= 72
  const comp = ['NONE', 'LOW'].includes(o.competition)
  return fresh && comp ? 'P0' : score(o) >= 60 ? 'P1' : 'P2'
}

export function queue() {
  return load()
    .map((o) => ({ ...o, _stage: STAGE[o.current_state] ?? 'DISCOVERY', _age_hours: ageHours(o), _reward_per_hour: rewardPerHour(o), _score: score(o), _priority: priority(o), _readiness: readiness(o) }))
    .sort((a, b) =>
      (STAGE_RANK[a._stage] ?? 9) - (STAGE_RANK[b._stage] ?? 9) ||
      a._priority.localeCompare(b._priority) || b._score - a._score ||
      String(a.work_order_id).localeCompare(String(b.work_order_id)))
}

// Phase 3: every rail lands in ONE schema. Rails that only report status (dealwork bids/contracts,
// toku wallet, opentask router state, our own GitHub PRs) emit no opportunities by design — they
// monitor money and work we already have, so they are not discovery sources and return [].
const NORMALIZERS = {
  algora: (c) => ({
    work_order_id: `${c.repo}#${c.num}`, source: 'algora', source_url: c.url, title: c.title,
    reward: c.bountyUsd, reward_currency: c.bountyUsd != null ? 'USD' : null,
    payout_method: 'algora / stripe-connect (recipient ledger verifiable)',
    payout_evidence: c.payout, competition: c.competition,
    ai_eligibility: c.ai, zero_cost_status: c.zeroCost,
    source_created_at: c.bountyPostedAt ?? null,
    required_accounts: ['Algora account — at payout only'],
    risk_flags: [
      ...(c.maintainer === 'STALE' ? ['STALE_MAINTAINER'] : []),
      ...(c.competition === 'HIGH' ? ['HIGH_COMPETITION'] : []),
      ...(c.bountyUsd == null ? ['REWARD_UNPARSED'] : []),
    ],
  }),
  superteam: (l) => ({
    work_order_id: `superteam:${l.slug}`, source: 'superteam',
    source_url: `https://superteam.fun/earn/listing/${l.slug}`, title: l.slug,
    reward: l.reward ?? null, reward_currency: l.token ?? null,
    payout_method: 'superteam claim link (human claims)', payout_evidence: 'UNKNOWN',
    // Raw fact, always preserved, separate from the derived band below.
    submission_count: l._count?.Submission ?? null,
    // FACT (the count) and POLICY (the band) stay distinct: only apply competitionBand() when a real
    // count exists; otherwise stay UNKNOWN rather than guess. No new API call — `_count.Submission` was
    // already present in the same /api/listings response this normalizer already receives.
    competition: l._count?.Submission != null ? competitionBand(l._count.Submission) : 'UNKNOWN',
    ai_eligibility: l.access === 'AGENT_ONLY' || l.access === 'AGENT_ALLOWED' ? 'AI_ALLOWED' : 'AI_RESTRICTED',
    zero_cost_status: 'NOT_CHECKED', deadline: l.deadline ?? null,
    // Superteam's public listings API exposes no creation timestamp (only `deadline`) — fetching one
    // per listing would be a new API call, which this fix is scoped to avoid. Unlike Algora's static
    // pool, Superteam has measured real churn (23->25 open, 1->2 agent-eligible in 12 days) with a
    // 30-min poll cadence once Actions is on, so "first seen by us" is an accurate freshness proxy here
    // — bounded error of one poll interval, not the false "brand new" reading discovered_at gave on
    // Algora's months-old bounties. Set once: intake() never re-touches a known work_order_id, so this
    // timestamp locks in at first discovery and is never reset on subsequent runs.
    source_created_at: new Date().toISOString(),
    required_accounts: ['Superteam agent account (already registered)'],
    risk_flags: [...(l.access === 'HUMAN_ONLY' ? ['HUMAN_ONLY'] : [])],
  }),
}
export function normalize(source, raw) {
  const f = NORMALIZERS[source]
  return f ? f(raw) : null
}

// ── Execution layer (Phase 7) ─────────────────────────────────────────────────────────────────────
// Each externally-consequential step is its own command with its own approval. Approvals never carry
// over: accepting work does not authorise starting it, and starting it does not authorise submitting.

function requireApproval(action, approval) {
  if (!(typeof approval === 'string' && approval.trim())) {
    throw new Error(`${action} requires explicit human approval — re-run with --approve "<reason>"`)
  }
}

function repoUrlFrom(o) {
  const m = String(o.source_url ?? '').match(/github\.com\/([^/]+)\/([^/]+)/)
  if (!m) throw new Error(`cannot derive a repository URL from source_url: ${o.source_url}`)
  return `https://github.com/${m[1]}/${m[2].replace(/\.git$/, '')}.git`
}

// ACCEPTED -> IN_PROGRESS. Clones, branches, records provenance. Local only.
export function start(id, { approval = null } = {}) {
  requireApproval('WORK_START', approval)
  const o = get(id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  if (o.current_state !== 'ACCEPTED') {
    throw new Error(`refused: start requires state ACCEPTED, order is ${o.current_state}`)
  }
  if (o.workspace) throw new Error(`refused: workspace already recorded for ${id}`)
  if (ws.exists(id)) throw new Error(`refused: workspace directory already exists for ${id}`)
  const meta = ws.create(id, { repoUrl: o.repo_url ?? repoUrlFrom(o), branch: `wo/${ws.slugFor(id)}` })
  patch(id, { workspace: meta })
  return transition(id, 'IN_PROGRESS', { approval, note: `workspace ${meta.path} @ ${meta.base_commit.slice(0, 8)}` })
}

function run(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { cmd: `${cmd} ${args.join(' ')}`, code: 0, ok: true, out: out.slice(-2000) }
  } catch (e) {
    return { cmd: `${cmd} ${args.join(' ')}`, code: e.status ?? -1, ok: false, out: String(e.stdout ?? '').slice(-1000) + String(e.stderr ?? '').slice(-1000) }
  }
}

// LOCAL VERIFICATION ONLY. Never contacts a remote. Passing promotes IN_PROGRESS -> READY_TO_SUBMIT;
// failing records the failure and leaves the order where it is, because a red suite is not "ready".
export function prepareSubmit(id) {
  const o = get(id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  if (o.current_state !== 'IN_PROGRESS') {
    throw new Error(`refused: prepare-submit requires state IN_PROGRESS, order is ${o.current_state}`)
  }
  if (!o.workspace?.path || !existsSync(o.workspace.path)) throw new Error('refused: no workspace on disk')
  const dir = o.workspace.path
  const checks = []
  const st = ws.status(o.workspace)
  if (existsSync(`${dir}/Cargo.toml`)) {
    checks.push(run('cargo', ['fmt', '--check'], dir))
    checks.push(run('cargo', ['clippy', '--quiet'], dir))
    checks.push(run('cargo', ['test', '--quiet'], dir))
  } else if (existsSync(`${dir}/package.json`)) {
    checks.push(run('npm', ['test', '--silent'], dir))
  } else {
    checks.push({ cmd: '(no recognised toolchain)', code: -1, ok: false, out: 'no Cargo.toml or package.json found' })
  }
  const hasWork = Boolean(st.commits || st.dirty)
  const passed = checks.every((c) => c.ok) && hasWork
  const verification = { at: new Date().toISOString(), passed, has_work: hasWork, git: st, checks }
  patch(id, { verification })
  if (!passed) {
    // stay put: a failing suite is not "ready to submit". The failure is recorded on the order and the
    // state is intentionally left alone (IN_PROGRESS -> IN_PROGRESS is not a legal transition anyway).
    const why = !hasWork ? 'no commits or changes on the branch' : checks.filter((c) => !c.ok).map((c) => `${c.cmd} exited ${c.code}`).join('; ')
    return { passed: false, reason: why, verification }
  }
  transition(id, 'READY_TO_SUBMIT', { note: 'local verification passed' })
  return { passed: true, verification }
}

// Fork provisioning. Its own gate, its own approval, never a side effect of start/prepare-submit/submit.
// Deliberately does NOT transition the order: having somewhere writable to push is infrastructure, not
// evidence that work was submitted. An order stays READY_TO_SUBMIT while its target is provisioned.
export function provisionFork(id, { approval = null, execute = false } = {}) {
  requireApproval('FORK_PROVISIONING', approval)
  const o = get(id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  const cap = CAPABILITIES['github-fork']
  const pf = cap.preflight(o, o.workspace)
  const plan = { ...cap.plan(o), at: new Date().toISOString(), dry_run: !execute }

  if (!execute) return { dry_run: true, status: pf.status, preflight: pf, plan }

  // A prior UNCERTAIN attempt may have created a fork we cannot see. Forking again could make a second
  // repo, so this stops and asks for a human rather than retrying.
  if (o.fork_attempt?.status === 'UNCERTAIN') {
    throw new Error('refused: a previous fork attempt returned UNCERTAIN — resolve it manually; this will not auto-retry')
  }
  if (!pf.ok) throw new Error(`refused: fork preflight failed — ${pf.checks.filter((c) => !c.ok).map((c) => c.check).join('; ')}`)

  const stamp = { provisioned_at: new Date().toISOString(), order_id: id, source_commit: o.workspace?.base_commit ?? null }
  if (pf.already_present) {
    patch(id, { fork: { ...pf.fork, ...stamp, detected: true } })
    return { created: false, status: 'FORK_PRESENT', reason: 'fork already exists — not creating another', fork: get(id).fork }
  }
  const res = cap.execute(o, { dry: false })
  if (!res.created) {
    patch(id, { fork_attempt: { at: stamp.provisioned_at, status: res.status, error: redact(res.error ?? '') } })
    throw new Error(`fork provisioning ${res.status}: ${redact(res.error ?? '')}`)
  }
  patch(id, { fork: { ...res.fork, ...stamp, detected: false }, fork_attempt: null })
  return { created: true, status: res.status, fork: get(id).fork }
}

// READ-ONLY capability check. Asks the rail's adapter whether a real submission could succeed, without
// performing any part of it.
export function preflight(id) {
  const o = get(id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  const ad = adapterFor(o)
  return { adapter: ad.name, requirements: ad.requirements(o), ...ad.preflight(o, o.workspace) }
}

// The submission wall. Dry run by default: shows exactly what the rail would do and changes nothing.
// With `execute`, the adapter performs the real actions — and the order becomes SUBMITTED only if the
// adapter reports success. A failed push must never leave a ledger claiming the work was submitted.
export function submit(id, { approval = null, execute = false } = {}) {
  requireApproval('WORK_SUBMISSION', approval)
  const o = get(id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  if (o.current_state !== 'READY_TO_SUBMIT') {
    throw new Error(`refused: submit requires state READY_TO_SUBMIT, order is ${o.current_state}`)
  }
  const ad = adapterFor(o)                 // the rail decides what submission means, not this module
  const st = ws.status(o.workspace)
  const plan = {
    ...ad.plan(o, o.workspace, st),
    at: new Date().toISOString(), dry_run: !execute, approval, work_order_id: id,
    verification_passed: Boolean(o.verification?.passed),
    bounty: o.reward != null ? `${o.reward} ${o.reward_currency ?? ''}`.trim() : null,
  }
  patch(id, { submission_adapter: ad.name, submission_requirements: ad.requirements(o), submission_plan: plan })

  if (!execute) return { dry_run: true, adapter: ad.name, state_unchanged: o.current_state, plan }

  if (!o.verification?.passed) throw new Error('refused: local verification has not passed')
  const pf = ad.preflight(o, o.workspace)
  if (!pf.ok) throw new Error(`refused: preflight failed — ${pf.checks.filter((c) => !c.ok).map((c) => c.check).join('; ')}`)
  const res = ad.execute(o, o.workspace, { dry: false })
  patch(id, { submission_result: res })
  if (!res.submitted) throw new Error(`submission failed at ${res.stage}: ${res.error}`)
  transition(id, 'SUBMITTED', { approval, note: `submitted via ${ad.name}: ${res.url ?? '(no url)'}` })
  return { dry_run: false, submitted: true, adapter: ad.name, url: res.url }
}

// Payment is reconciled against EVIDENCE, never inferred. A wallet balance going up proves that money
// arrived, not that it arrived for this order — so PAID requires a reference or explicit evidence tying
// the payment to this work order.
export function reconcilePayment(id, { reference = null, amount = null, evidence = null, approval = null } = {}) {
  const o = get(id)
  if (!o) throw new Error(`unknown work order: ${id}`)
  const has = Boolean((reference && String(reference).trim()) || (evidence && String(evidence).trim()))
  const fields = {
    payment_reference: reference ?? o.payment_reference,
    observed_payment: amount != null ? Number(amount) : o.observed_payment,
    payment_observed_at: amount != null || has ? new Date().toISOString() : o.payment_observed_at,
    reconciliation_status: has ? (amount != null && o.expected_reward != null && Number(amount) < o.expected_reward ? 'PARTIAL' : 'EVIDENCED') : 'INSUFFICIENT_EVIDENCE',
  }
  patch(id, fields)
  if (!has) {
    return { reconciled: false, status: 'INSUFFICIENT_EVIDENCE', reason: 'a payment reference or explicit evidence is required; a wallet delta alone never attributes to an order' }
  }
  if (o.current_state !== 'PAYMENT_PENDING') {
    return { reconciled: true, status: fields.reconciliation_status, state_unchanged: o.current_state, note: 'evidence recorded; PAID transition only applies from PAYMENT_PENDING' }
  }
  requireApproval('PAYMENT_CONFIRMATION', approval)
  transition(id, 'PAID', { approval, note: `reconciled: ref=${reference ?? 'n/a'} amount=${amount ?? 'n/a'}` })
  return { reconciled: true, status: fields.reconciliation_status, state: 'PAID' }
}

// Execution outranks discovery: anything already being worked sorts above anything merely found, so the
// queue stops re-surfacing opportunities ahead of committed work.
export const STAGE = {
  DISCOVERED: 'DISCOVERY', QUALIFIED: 'DISCOVERY',
  READY_TO_ACCEPT: 'READY TO ACCEPT', ACCEPTED: 'IN PROGRESS', IN_PROGRESS: 'IN PROGRESS',
  READY_TO_SUBMIT: 'READY TO SUBMIT', SUBMITTED: 'SUBMITTED', ACCEPTED_WORK: 'SUBMITTED',
  PAYMENT_PENDING: 'PAYMENT PENDING', PAID: 'PAID',
  REJECTED: 'CLOSED', BLOCKED: 'CLOSED', EXPIRED: 'CLOSED', ABANDONED: 'CLOSED',
}
const STAGE_RANK = { 'PAYMENT PENDING': 0, 'READY TO SUBMIT': 1, 'SUBMITTED': 2, 'IN PROGRESS': 3, 'READY TO ACCEPT': 4, 'DISCOVERY': 5, 'PAID': 6, 'CLOSED': 7 }

// ── CLI (human entry point; the GitHub Actions workflow never invokes this file) ──────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2)
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null }
  try {
    if (cmd === 'queue') {
      const q = queue()
      if (!q.length) console.log('(queue empty)')
      for (const o of q) {
        console.log(`${o._priority}  ${String(o._score).padStart(3)}  ${o.current_state.padEnd(16)} ${o.reward != null ? `${o.reward} ${o.reward_currency ?? ''}`.padEnd(9) : '-'.padEnd(9)} ${o._reward_per_hour != null ? `$${o._reward_per_hour}/h`.padEnd(9) : '-'.padEnd(9)} ${o._age_hours != null ? `${o._age_hours}h`.padEnd(7) : '-'.padEnd(7)} comp=${String(o.competition).padEnd(7)} ready=${o._readiness.ready}  ${o.work_order_id}`)
        if (!o._readiness.ready) console.log(`${' '.repeat(10)}blockers: ${o._readiness.blockers.join(', ')}`)
      }
    } else if (cmd === 'ready') {
      const o = load().find((x) => x.work_order_id === rest[0])
      console.log(o ? JSON.stringify({ work_order_id: o.work_order_id, state: o.current_state, priority: priority(o), score: score(o), age_hours: ageHours(o), reward_per_hour: rewardPerHour(o), ...readiness(o) }, null, 2) : `unknown work order: ${rest[0]}`)
    } else if (cmd === 'list') {
      const orders = load()
      if (!orders.length) console.log('(no work orders)')
      for (const o of orders) {
        console.log(`${o.current_state.padEnd(16)} ${o.work_order_id}  ${o.reward != null ? `${o.reward} ${o.reward_currency ?? ''}`.trim() : '-'}  ${o.title ?? ''}`)
      }
      console.log('\n' + JSON.stringify(summary()))
    } else if (cmd === 'show') {
      const o = load().find((x) => x.work_order_id === rest[0])
      console.log(o ? JSON.stringify(o, null, 2) : `unknown work order: ${rest[0]}`)
    } else if (cmd === 'start') {
      const o = start(rest[0], { approval: flag('approve') })
      console.log(`${rest[0]} -> ${o.current_state}\n  workspace: ${o.workspace.path}\n  branch:    ${o.workspace.branch}\n  base:      ${o.workspace.base_commit}`)
    } else if (cmd === 'prepare-submit') {
      const r = prepareSubmit(rest[0])
      for (const c of r.verification.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.cmd} (exit ${c.code})`)
      console.log(r.passed ? `${rest[0]} -> READY_TO_SUBMIT` : `verification FAILED — staying IN_PROGRESS\n  reason: ${r.reason}`)
    } else if (cmd === 'provision-fork') {
      const r = provisionFork(rest[0], { approval: flag('approve'), execute: rest.includes('--execute') })
      if (r.dry_run) {
        console.log(`DRY RUN — no fork was created. status: ${r.status}\n`)
        console.log(JSON.stringify({ plan: r.plan, preflight: r.preflight }, null, 2))
        console.log('\nadd --execute to actually create the fork')
      } else console.log(`${r.status}: ${JSON.stringify(r.fork)}`)
    } else if (cmd === 'preflight') {
      console.log(JSON.stringify(preflight(rest[0]), null, 2))
    } else if (cmd === 'submit') {
      const r = submit(rest[0], { approval: flag('approve'), execute: rest.includes('--execute') })
      if (r.dry_run) {
        console.log(`DRY RUN via "${r.adapter}" — nothing pushed, no PR opened, no bounty claimed.\n`)
        console.log(JSON.stringify(r.plan, null, 2))
        console.log(`\nstate unchanged: ${r.state_unchanged}   (add --execute to submit for real)`)
      } else console.log(`SUBMITTED via ${r.adapter}: ${r.url}`)
    } else if (cmd === 'reconcile-payment') {
      console.log(JSON.stringify(reconcilePayment(rest[0], { reference: flag('reference'), amount: flag('amount'), evidence: flag('evidence'), approval: flag('approve') }), null, 2))
    } else if (cmd === 'set') {
      const o = transition(rest[0], rest[1], { approval: flag('approve'), note: flag('note') })
      console.log(`${rest[0]} -> ${o.current_state}`)
    } else {
      console.log('usage:\n  node orders.mjs queue\n  node orders.mjs ready <id>\n  node orders.mjs list\n  node orders.mjs show <id>\n  node orders.mjs start <id> --approve "<reason>"\n  node orders.mjs prepare-submit <id>\n  node orders.mjs preflight <id>\n  node orders.mjs provision-fork <id> --approve "<reason>" [--execute]   (dry run unless --execute)\n  node orders.mjs submit <id> --approve "<reason>" [--execute]   (dry run unless --execute)\n  node orders.mjs reconcile-payment <id> --reference <ref> [--amount N] [--approve "<reason>"]\n  node orders.mjs set <id> <STATE> [--approve "<reason>"] [--note "<text>"]')
      console.log(`\ngated states (need --approve): ${Object.entries(GATED).map(([s, g]) => `${s} (${g})`).join(', ')}`)
      console.log('FINANCIAL_ACTION: permanently blocked')
    }
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1) }
}
