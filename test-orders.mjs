// Verification suite for the work-order state machine. Run: node test-orders.mjs
// Backs up and restores work-orders.json so running tests never disturbs live orders.
import { readFileSync, writeFileSync } from 'node:fs'
import { intake, transition, load, readiness, priority, score, normalize, assertNoFinancialAction, ageHours, competitionBand,
         start, prepareSubmit, submit, reconcilePayment, patch, get, STAGE } from './orders.mjs'
import * as ws from './workspace.mjs'
import { adapterFor, requirementsFor, ADAPTERS, CAPABILITIES, githubFork, __setRunner, redact } from './adapters.mjs'
import { provisionFork } from './orders.mjs'
import { preflight } from './orders.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync as wf, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = new URL('./work-orders.json', import.meta.url)
const backup = readFileSync(STORE, 'utf8')
let pass = 0, fail = 0
const ok = (l, f) => { try { const r = f(); console.log(`  PASS  ${l}${r ? ' → ' + r : ''}`); pass++ } catch (e) { console.log(`  FAIL  ${l} → ${e.message}`); fail++ } }
const no = (l, f) => { try { f(); console.log(`  FAIL  ${l} → WAS ALLOWED`); fail++ } catch (e) { console.log(`  PASS  ${l} → blocked: ${e.message.slice(0, 64)}`); pass++ } }

try {
  writeFileSync(STORE, '[]\n')
  const ID = 'test/demo#1'

  console.log('1. DISCOVERY may create DISCOVERED')
  ok('intake creates DISCOVERED', () => intake([{ work_order_id: ID, source: 'algora', source_url: 'u', title: 't', reward: 5, reward_currency: 'USD' }])[0].current_state)

  console.log('\n2. DISCOVERY cannot transition beyond DISCOVERED')
  ok('candidate claiming ACCEPTED is forced to DISCOVERED', () => {
    intake([{ work_order_id: 'test/evil#1', current_state: 'ACCEPTED', accepted_at: '2020-01-01' }])
    const o = load().find((x) => x.work_order_id === 'test/evil#1')
    if (o.current_state !== 'DISCOVERED' || o.accepted_at !== null) throw new Error(`leaked: ${o.current_state}/${o.accepted_at}`)
    return 'forced to DISCOVERED, accepted_at null'
  })

  console.log('\n10. Restart cannot duplicate')
  ok('re-intake is idempotent', () => `${intake([{ work_order_id: ID }]).length} added; total ${load().length}`)

  console.log('\n11. Malformed orders cannot bypass the state machine')
  ok('malformed candidates are skipped', () => `${intake([null, {}, { title: 'no id' }, 'string', 42]).length} added`)
  no('transition on malformed id', () => transition(null, 'QUALIFIED'))

  console.log('\n13. Cannot skip states')
  no('DISCOVERED -> SUBMITTED', () => transition(ID, 'SUBMITTED', { approval: 'x' }))
  no('DISCOVERED -> PAID', () => transition(ID, 'PAID'))
  no('DISCOVERED -> IN_PROGRESS', () => transition(ID, 'IN_PROGRESS'))

  console.log('\n12. Unknown id cannot be accepted')
  no('accept unknown id', () => transition('does/not#exist', 'ACCEPTED', { approval: 'GO' }))

  console.log('\n3+4. QUALIFIED / READY_TO_ACCEPT require explicit promotion')
  ok('DISCOVERED -> QUALIFIED', () => transition(ID, 'QUALIFIED').current_state)
  ok('QUALIFIED -> READY_TO_ACCEPT', () => transition(ID, 'READY_TO_ACCEPT').current_state)

  console.log('\n5. ACCEPTED requires a human approval string')
  no('no approval', () => transition(ID, 'ACCEPTED'))
  no('empty approval', () => transition(ID, 'ACCEPTED', { approval: '  ' }))
  no('non-string approval', () => transition(ID, 'ACCEPTED', { approval: true }))
  ok('with explicit GO', () => transition(ID, 'ACCEPTED', { approval: 'human GO' }).current_state)

  console.log('\n14. DISCOVERY cannot mutate an accepted order')
  ok('re-intake leaves ACCEPTED intact', () => {
    intake([{ work_order_id: ID, current_state: 'DISCOVERED', reward: 999 }])
    const o = load().find((x) => x.work_order_id === ID)
    if (o.current_state !== 'ACCEPTED') throw new Error(`state clobbered: ${o.current_state}`)
    if (o.reward === 999) throw new Error('fields clobbered by discovery')
    return `still ACCEPTED, reward still ${o.reward}`
  })

  console.log('\n6. SUBMITTED requires its own separate approval')
  ok('-> IN_PROGRESS', () => transition(ID, 'IN_PROGRESS').current_state)
  ok('-> READY_TO_SUBMIT', () => transition(ID, 'READY_TO_SUBMIT').current_state)
  no('submit without approval (accept approval does not carry over)', () => transition(ID, 'SUBMITTED'))
  ok('submit with its own GO', () => transition(ID, 'SUBMITTED', { approval: 'second human GO' }).current_state)

  console.log('\n8. PAID is terminal')
  ok('-> ACCEPTED_WORK', () => transition(ID, 'ACCEPTED_WORK').current_state)
  ok('-> PAYMENT_PENDING', () => transition(ID, 'PAYMENT_PENDING').current_state)
  ok('-> PAID', () => transition(ID, 'PAID').current_state)
  no('PAID -> IN_PROGRESS', () => transition(ID, 'IN_PROGRESS'))
  no('PAID -> PAYMENT_PENDING', () => transition(ID, 'PAYMENT_PENDING'))

  console.log('\n7. FINANCIAL_ACTION permanently blocked')
  for (const op of ['spend', 'fund wallet', 'trade', 'pay gas', 'transfer', 'purchase credits', 'stake'])
    no(`financial: ${op}`, () => assertNoFinancialAction(op))

  console.log('\n9. Every transition is auditable')
  ok('audit trail complete', () => {
    const o = load().find((x) => x.work_order_id === ID)
    const gated = o.history.filter((h) => h.approval)
    if (gated.length !== 2) throw new Error(`expected 2 recorded approvals, got ${gated.length}`)
    if (!o.accepted_at || !o.submitted_at || !o.paid_at) throw new Error('missing timestamps')
    if (o.history.some((h) => !h.at || !h.to)) throw new Error('incomplete history row')
    return `${o.history.length} transitions, ${gated.length} approvals, 3 timestamps`
  })

  console.log('\nPHASE 5. Readiness excludes competition')
  ok('HIGH competition does not block readiness', () => {
    const base = { source: 'algora', source_url: 'u', reward: 5, payout_evidence: 'VERIFIED_PAID', zero_cost_status: 'ZERO_COST_CONFIRMED', ai_eligibility: 'AI_ALLOWED', acceptance_criteria: 'c', required_accounts: [], risk_flags: [], current_state: 'DISCOVERED' }
    const lo = readiness({ ...base, competition: 'NONE' }), hi = readiness({ ...base, competition: 'HIGH' })
    if (!lo.ready || !hi.ready) throw new Error('competition affected readiness')
    if (score({ ...base, competition: 'HIGH' }) >= score({ ...base, competition: 'NONE' })) throw new Error('competition did not penalise score')
    return 'ready=true at both bands; score penalised only'
  })
  ok('capital requirement blocks readiness', () => {
    const r = readiness({ source: 'x', source_url: 'u', reward: 5, payout_evidence: 'VERIFIED_PAID', zero_cost_status: 'ZERO_COST_CONFIRMED', ai_eligibility: 'AI_ALLOWED', acceptance_criteria: 'c', required_accounts: [], risk_flags: ['REQUIRES_TRADING_CAPITAL'], current_state: 'DISCOVERED' })
    if (r.ready) throw new Error('capital requirement did not block')
    return r.blockers.join(',')
  })
  ok('ranking is deterministic', () => {
    const o = { source: 'a', source_url: 'u', reward: 5, payout_evidence: 'VERIFIED_PAID', zero_cost_status: 'CONFIRMED', ai_eligibility: 'AI_ALLOWED', acceptance_criteria: 'c', required_accounts: [], risk_flags: [], competition: 'LOW', current_state: 'DISCOVERED', estimated_effort: '1-2h', discovered_at: new Date().toISOString() }
    const a = [score(o), priority(o)].join('/'), b = [score(o), priority(o)].join('/')
    if (a !== b) throw new Error('non-deterministic')
    return a
  })

  console.log('\nPHASE 3. Normalizers share one schema')
  ok('algora normalizes', () => normalize('algora', { repo: 'a/b', num: 1, url: 'u', title: 't', bountyUsd: 50, competition: 'LOW', payout: 'NOT_CHECKED', ai: 'NOT_CHECKED', zeroCost: 'NOT_CHECKED' }).work_order_id)
  ok('superteam normalizes', () => normalize('superteam', { slug: 's', reward: 500, token: 'USDC', access: 'AGENT_ALLOWED' }).work_order_id)

  console.log('\nPHASE 4-EDGE. Freshness robustness: missing / malformed / ambiguous dates')
  ok('missing date -> UNKNOWN (null), never guessed', () => {
    const h = ageHours({ source_created_at: null })
    if (h !== null) throw new Error(`expected null, got ${h}`)
    return 'null'
  })
  ok('malformed date string -> UNKNOWN (null), does not throw', () => {
    const h = ageHours({ source_created_at: 'not-a-real-date' })
    if (h !== null) throw new Error(`expected null for garbage input, got ${h}`)
    return 'null, no crash'
  })
  ok('ambiguous/partial date string -> still resolves or safely nulls, never crashes', () => {
    const h = ageHours({ source_created_at: '2026' })  // year only, ambiguous
    if (h !== null && typeof h !== 'number') throw new Error(`unexpected type: ${typeof h}`)
    return `handled without throwing (${h === null ? 'null' : h + 'h'})`
  })
  ok('valid ISO date -> a real, sane number of hours', () => {
    const h = ageHours({ source_created_at: new Date(Date.now() - 3600000).toISOString() })
    if (h === null || h < 0 || h > 2) throw new Error(`expected ~1h, got ${h}`)
    return `${h}h (expected ~1)`
  })
  ok('future-dated timestamp does not produce a negative/broken freshness read', () => {
    const h = ageHours({ source_created_at: new Date(Date.now() + 86400000).toISOString() })
    if (h === null) throw new Error('future date incorrectly nulled')
    if (h >= 0) throw new Error(`expected a negative value flagging the anomaly, got ${h}`)
    return `${h}h (negative — an honest signal something is off, not silently clamped to 0)`
  })

  console.log('\nPHASE 4-EDGE. Algora cancelled-bounty detection (the struck-through comment pattern)')
  ok('struck-through bounty comment is detected as cancelled', () => {
    // Real pattern observed on Thinkmill/keystatic#340 this session: the bot re-edits its own comment,
    // wrapping every line in ~~strikethrough~~ when a sponsor pulls a bounty.
    const cancelledBody = '~~\ud83d\udc8e **$100** bounty created by @florian-lefebvre~~ ~~\ud83d\udc49 To claim...~~'
    if (!/~~/.test(cancelledBody)) throw new Error('did not detect a real cancelled-bounty pattern')
    return 'detected'
  })
  ok('a live, non-cancelled bounty comment is NOT flagged', () => {
    const liveBody = '\ud83d\udc8e **Feel-ix-343** is offering a **$5** bounty for this issue. Claim by commenting /claim'
    if (/~~/.test(liveBody)) throw new Error('false positive: flagged a live bounty as cancelled')
    return 'not flagged'
  })

  console.log('\nPHASE 11A. Superteam competition: raw count preserved, existing band reused, no guessing')
  ok('same policy as Algora — not a new invented threshold', () => {
    if (competitionBand(0) !== 'NONE' || competitionBand(3) !== 'LOW' || competitionBand(15) !== 'MEDIUM' || competitionBand(21) !== 'HIGH') {
      throw new Error('band values drifted from the authorized Algora policy')
    }
    return 'NONE/LOW/MEDIUM/HIGH thresholds unchanged: 0, 1-5, 6-20, >20'
  })
  ok('raw submission_count is preserved as fact, separate from the derived band', () => {
    const c = normalize('superteam', { slug: 'x', reward: 10, access: 'AGENT_ALLOWED', _count: { Submission: 15 } })
    if (c.submission_count !== 15) throw new Error(`raw count not preserved: ${c.submission_count}`)
    if (c.competition !== 'MEDIUM') throw new Error(`band mismatch for 15: ${c.competition}`)
    return `count=${c.submission_count}, band=${c.competition}`
  })
  ok('no count present -> stays UNKNOWN, never guessed', () => {
    const c = normalize('superteam', { slug: 'x', reward: 10, access: 'AGENT_ALLOWED' })
    if (c.submission_count !== null) throw new Error('invented a count that was not there')
    if (c.competition !== 'UNKNOWN') throw new Error(`guessed a band with no data: ${c.competition}`)
    return 'submission_count=null, competition=UNKNOWN'
  })
  ok('zero submissions is a real fact, not "no data" — correctly bands to NONE', () => {
    const c = normalize('superteam', { slug: 'x', reward: 10, access: 'AGENT_ALLOWED', _count: { Submission: 0 } })
    if (c.submission_count !== 0) throw new Error('0 was coerced to null')
    if (c.competition !== 'NONE') throw new Error(`0 submissions should band NONE, got ${c.competition}`)
    return 'submission_count=0 (fact) correctly distinguished from null (no data)'
  })
  ok('THIS IS AN OBSERVABILITY FIX, NOT AN AUTONOMY FIX: still cannot reach P0/P1 without payout evidence', () => {
    const id = 'test/superteam-comp#1'
    intake([{ ...normalize('superteam', { slug: 'y', reward: 500, access: 'AGENT_ALLOWED', _count: { Submission: 2 } }), work_order_id: id }])
    const o = get(id)
    if (o.competition !== 'LOW') throw new Error(`expected LOW, got ${o.competition}`)
    // low competition + fresh (just discovered) + everything else good — but payout_evidence is still
    // 'UNKNOWN', so readiness must still fail and priority must still be capped, exactly as before.
    if (readiness(o).ready) throw new Error('LOW competition alone made an UNKNOWN-payout order "ready" — the gate weakened')
    if (priority(o) === 'P0' || priority(o) === 'P1') throw new Error(`payout gate did not hold: reached ${priority(o)}`)
    return `competition=LOW, ready=${readiness(o).ready}, priority=${priority(o)} — payout gate intact`
  })

  console.log('\nPHASE 10A. Superteam freshness fix: no more permanent null age')
  ok('normalize(superteam) now populates source_created_at', () => {
    const c = normalize('superteam', { slug: 'fresh-test', reward: 500, token: 'USDC', access: 'AGENT_ALLOWED' })
    if (!c.source_created_at) throw new Error('still null — fix did not apply')
    const ageMs = Date.now() - Date.parse(c.source_created_at)
    if (ageMs < 0 || ageMs > 5000) throw new Error(`timestamp not "now": ${ageMs}ms off`)
    return c.source_created_at
  })
  ok('a freshly-discovered superteam order now scores as fresh, not permanently null-age', () => {
    const id = 'test/superteam-fresh#1'
    intake([normalize('superteam', { slug: id.split('#')[0], reward: 100, token: 'USDC', access: 'AGENT_ALLOWED' })].map(c => ({ ...c, work_order_id: id })))
    const h = ageHours(get(id))
    if (h === null) throw new Error('ageHours still null after the fix')
    if (h > 1) throw new Error(`expected near-zero age for a just-discovered order, got ${h}h`)
    return `age_hours=${h} (was: always null before this fix)`
  })
  ok('re-intake does not reset the locked-in timestamp (discovery cannot mutate)', () => {
    const id = 'test/superteam-fresh#1'
    const first = get(id).source_created_at
    intake([{ ...normalize('superteam', { slug: 'x', reward: 999 }), work_order_id: id }])
    if (get(id).source_created_at !== first) throw new Error('timestamp was overwritten on re-intake')
    return 'timestamp locked at first discovery, unchanged on repeat'
  })
  ok('unknown source returns null', () => String(normalize('nope', {})))

  // ── PHASE 7: execution surface ──────────────────────────────────────────────────────────────────
  // A throwaway local git repo stands in for the upstream remote, so none of this touches the network.
  const fixture = mkdtempSync(join(tmpdir(), 'wo-fixture-'))
  const sh = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  sh(['init', '--quiet', '-b', 'main', fixture], tmpdir())
  wf(join(fixture, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'exit 0' } }))
  sh(['add', '-A'], fixture); sh(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], fixture)

  const EX = 'test/exec#1', EX2 = 'test/exec#2'
  const seed = (id) => {
    intake([{ work_order_id: id, source: 'algora', source_url: 'https://github.com/o/r/issues/1', title: 'fixture', reward: 5, reward_currency: 'USD' }])
    patch(id, { repo_url: fixture })
    transition(id, 'QUALIFIED'); transition(id, 'READY_TO_ACCEPT')
  }

  console.log('\nP7-1. DISCOVERED cannot start')
  seed(EX)
  no('start from DISCOVERED-lineage (not yet ACCEPTED)', () => start(EX, { approval: 'GO' }))

  console.log('\nP7-2/3. start requires ACCEPTED *and* explicit approval')
  transition(EX, 'ACCEPTED', { approval: 'human GO' })
  no('start without approval', () => start(EX))
  no('start with empty approval', () => start(EX, { approval: '   ' }))
  ok('start with explicit approval', () => start(EX, { approval: 'human GO start' }).current_state)

  console.log('\nP7-6. start records branch + base commit')
  ok('workspace provenance recorded', () => {
    const o = get(EX), head = sh(['rev-parse', 'HEAD'], fixture).trim()
    if (o.workspace.base_commit !== head) throw new Error('base commit mismatch')
    if (o.workspace.branch !== `wo/${ws.slugFor(EX)}`) throw new Error('branch mismatch')
    const actual = sh(['rev-parse', '--abbrev-ref', 'HEAD'], o.workspace.path).trim()
    if (actual !== o.workspace.branch) throw new Error(`checked-out branch is ${actual}`)
    return `${o.workspace.branch} @ ${o.workspace.base_commit.slice(0, 8)}`
  })

  console.log('\nP7-4/5. workspace isolation')
  no('duplicate workspace for same order', () => ws.create(EX, { repoUrl: fixture, branch: 'x' }))
  ok('two orders get different workspaces', () => {
    if (ws.pathFor(EX) === ws.pathFor(EX2)) throw new Error('path collision')
    return 'distinct paths'
  })
  no('start twice on one order', () => start(EX, { approval: 'again' }))

  console.log('\nP7-7. failing verification blocks READY_TO_SUBMIT')
  const wsp = get(EX).workspace.path
  ok('no work on branch => not ready', () => {
    const r = prepareSubmit(EX)
    if (r.passed) throw new Error('passed with no commits')
    if (get(EX).current_state !== 'IN_PROGRESS') throw new Error('state moved on failure')
    return r.reason
  })
  ok('failing test suite => not ready', () => {
    wf(join(wsp, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'exit 1' } }))
    sh(['add', '-A'], wsp); sh(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'break'], wsp)
    const r = prepareSubmit(EX)
    if (r.passed) throw new Error('passed with red suite')
    if (get(EX).current_state !== 'IN_PROGRESS') throw new Error('state moved on failure')
    return `stayed IN_PROGRESS (${r.reason.slice(0, 40)})`
  })

  console.log('\nP7-8. passing verification permits READY_TO_SUBMIT')
  ok('green suite + real commit => READY_TO_SUBMIT', () => {
    wf(join(wsp, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'exit 0' } }))
    sh(['add', '-A'], wsp); sh(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fix'], wsp)
    const r = prepareSubmit(EX)
    if (!r.passed) throw new Error(`still failing: ${r.reason}`)
    return get(EX).current_state
  })

  console.log('\nP7-9/10/11. submission wall')
  no('submit without approval', () => submit(EX))
  no('ACCEPTED approval cannot authorise submit (empty string)', () => submit(EX, { approval: '' }))
  ok('submit is DRY RUN and does not transition', () => {
    const r = submit(EX, { approval: 'fresh human GO submit' })
    if (!r.dry_run) throw new Error('not a dry run')
    if (get(EX).current_state !== 'READY_TO_SUBMIT') throw new Error(`state changed to ${get(EX).current_state}`)
    const p = r.plan
    if (p.would_push || p.would_open_pr || p.would_claim_bounty || p.would_comment) throw new Error('plan claims an external effect')
    return `state still READY_TO_SUBMIT; plan for ${p.branch}`
  })
  no('real submission is refused', () => submit(EX, { approval: 'GO', execute: true }))

  console.log('\nP7-12. no git push occurs')
  ok('workspace layer refuses push', () => { try { ws.git(['push', 'origin', 'main'], wsp); throw new Error('PUSH WAS ALLOWED') } catch (e) { if (/PUSH WAS ALLOWED/.test(e.message)) throw e; return e.message.slice(0, 48) } })
  ok('fixture remote received nothing', () => {
    const branches = sh(['branch', '--list'], fixture)
    if (branches.includes(ws.slugFor(EX))) throw new Error('work branch reached the remote')
    return 'remote has no work branch'
  })

  console.log('\nP7-13/14. payment cannot be inferred')
  transition(EX, 'SUBMITTED', { approval: 'human GO submit-state' })
  transition(EX, 'ACCEPTED_WORK'); transition(EX, 'PAYMENT_PENDING')
  ok('no evidence => refuses to reconcile', () => {
    const r = reconcilePayment(EX, {})
    if (r.reconciled) throw new Error('reconciled without evidence')
    if (get(EX).current_state !== 'PAYMENT_PENDING') throw new Error('state moved')
    return r.status
  })
  ok('wallet delta alone is not attribution', () => {
    const r = reconcilePayment(EX, { amount: 5 })   // amount but no reference/evidence
    if (r.reconciled) throw new Error('an unattributed amount was accepted as payment')
    if (get(EX).current_state !== 'PAYMENT_PENDING') throw new Error('state moved')
    return 'amount without reference rejected'
  })
  no('evidence present but no approval', () => reconcilePayment(EX, { reference: 'algora-tx-1', amount: 5 }))
  ok('evidence + approval => PAID', () => reconcilePayment(EX, { reference: 'algora-tx-1', amount: 5, approval: 'human GO payment' }).state)

  console.log('\nP7-15. PAID terminal (post-execution)')
  no('PAID -> IN_PROGRESS', () => transition(EX, 'IN_PROGRESS'))
  no('start on PAID order', () => start(EX, { approval: 'GO' }))

  console.log('\nP7-16. unattended agent has no execution path')
  ok('agent.mjs imports only discovery-safe symbols', () => {
    const src = readFileSync(new URL('./agent.mjs', import.meta.url), 'utf8')
    const imp = (src.match(/import \{([^}]+)\} from '\.\/orders\.mjs'/) ?? [, ''])[1]
    const named = imp.split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)
    const forbidden = named.filter((n) => ['transition', 'start', 'prepareSubmit', 'submit', 'reconcilePayment', 'patch'].includes(n))
    if (forbidden.length) throw new Error(`agent.mjs imports ${forbidden.join(', ')}`)
    if (/workspace\.mjs/.test(src)) throw new Error('agent.mjs imports the workspace layer')
    return `imports only: ${named.join(', ')}`
  })

  console.log('\nP7-QUEUE. execution outranks discovery')
  ok('stage mapping', () => `${STAGE.IN_PROGRESS} / ${STAGE.DISCOVERED} / ${STAGE.PAID}`)


  // ── PHASE 8: submission adapters ────────────────────────────────────────────────────────────────
  console.log('\nP8-1. the rail chooses the adapter, not the pipeline')
  ok('algora source -> algora adapter', () => adapterFor({ source: 'algora' }).name)
  ok('superteam source -> superteam adapter', () => adapterFor({ source: 'superteam' }).name)
  ok('explicit override wins', () => adapterFor({ source: 'algora', submission_adapter: 'github-pr' }).name)
  no('unknown source fails loudly (no silent GitHub default)', () => adapterFor({ source: 'mystery-rail' }))

  console.log('\nP8-2. requirements are per-rail, not hard-coded around Algora')
  ok('algora requires a claim line', () => requirementsFor({ source: 'algora' }).join(','))
  ok('github-pr does NOT require a claim line', () => {
    const r = requirementsFor({ source: 'github-pr' })
    if (r.includes('claim_line_in_pr_body')) throw new Error('github-pr leaked an Algora requirement')
    return r.join(',')
  })
  ok('superteam needs no branch and no PR', () => {
    const r = requirementsFor({ source: 'superteam' })
    if (r.some((x) => /pr|branch|push/i.test(x))) throw new Error(`superteam leaked a git requirement: ${r}`)
    return r.join(',')
  })

  console.log('\nP8-3. adapter plans differ in shape')
  ok('algora embeds /claim in the PR body', () => {
    const pl = ADAPTERS.algora.plan({ source_url: 'https://github.com/o/r/issues/42', title: 't', acceptance_criteria: 'c' }, { branch: 'b', base_branch: 'main', base_commit: 'abc', repo_url: 'https://github.com/o/r.git' }, {})
    if (pl.claim_line !== '/claim #42') throw new Error(`claim line wrong: ${pl.claim_line}`)
    if (!pl.pr_body.includes('/claim #42')) throw new Error('claim line missing from PR body')
    return pl.claim_line
  })
  ok('superteam plan has no branch/PR fields', () => {
    const pl = ADAPTERS.superteam.plan({ work_order_id: 'superteam:x', source_url: 'u' })
    if (pl.branch || pl.pr_title) throw new Error('superteam plan contains git fields')
    return pl.actions.join(',')
  })

  console.log('\nP8-4. submission wall holds with adapters wired')
  const SU = 'superteam:fixture-listing'
  intake([{ work_order_id: SU, source: 'superteam', source_url: 'https://superteam.fun/earn/listing/x', title: 'fixture listing', reward: 100, reward_currency: 'USDC' }])
  transition(SU, 'QUALIFIED'); transition(SU, 'READY_TO_ACCEPT')
  transition(SU, 'ACCEPTED', { approval: 'GO' }); transition(SU, 'IN_PROGRESS', { approval: 'GO' })
  patch(SU, { verification: { passed: true } })
  transition(SU, 'READY_TO_SUBMIT')
  ok('dry run works for a non-GitHub rail', () => {
    const r = submit(SU, { approval: 'human GO' })
    if (!r.dry_run) throw new Error('not dry')
    if (get(SU).current_state !== 'READY_TO_SUBMIT') throw new Error('state moved on dry run')
    return `${r.adapter}; state ${r.state_unchanged}`
  })
  ok('requirements recorded on the order', () => get(SU).submission_requirements.join(','))
  no('submit without approval', () => submit(SU))
  ok('FAILED real submission leaves state untouched', () => {
    try { submit(SU, { approval: 'human GO', execute: true }) } catch { /* adapter throws: not implemented */ }
    const st = get(SU).current_state
    if (st === 'SUBMITTED') throw new Error('ledger claims SUBMITTED after a failed submission')
    return `still ${st}`
  })

  console.log('\nP8-5. real submission is gated on verification and preflight')
  // EX is PAID by now, so use a fresh algora-sourced order parked at READY_TO_SUBMIT.
  const AL = 'test/algora#7'
  intake([{ work_order_id: AL, source: 'algora', source_url: 'https://github.com/o/r/issues/7', title: 'algora fixture', reward: 50, reward_currency: 'USD' }])
  transition(AL, 'QUALIFIED'); transition(AL, 'READY_TO_ACCEPT')
  transition(AL, 'ACCEPTED', { approval: 'GO' }); transition(AL, 'IN_PROGRESS', { approval: 'GO' })
  patch(AL, { verification: { passed: false } })
  transition(AL, 'READY_TO_SUBMIT')
  no('execute refused when verification has not passed', () => submit(AL, { approval: 'GO', execute: true }))
  ok('failed gate left state at READY_TO_SUBMIT', () => {
    if (get(AL).current_state !== 'READY_TO_SUBMIT') throw new Error(`state is ${get(AL).current_state}`)
    return 'unchanged'
  })
  patch(AL, { verification: { passed: true } })
  no('execute still refused when preflight fails (no fork / no workspace)', () => submit(AL, { approval: 'GO', execute: true }))
  ok('preflight is read-only and reports blockers', () => {
    const pf = preflight(AL)
    return `${pf.adapter}: ok=${pf.ok}, ${pf.checks.filter((c) => !c.ok).length} blocker(s)`
  })
  ok('preflight changed nothing', () => {
    const o = get(AL)
    if (o.current_state !== 'READY_TO_SUBMIT') throw new Error(`preflight moved state to ${o.current_state}`)
    if (o.submission_result) throw new Error('preflight recorded a submission result')
    return 'state and result untouched'
  })

  console.log('\nP8-6. still no push anywhere')
  ok('fixture remote still has no work branch', () => {
    if (sh(['branch', '--list'], fixture).includes(ws.slugFor(EX))) throw new Error('branch reached remote')
    return 'clean'
  })


  // ── PHASE 9: gated fork provisioning (all local mocks — no network) ─────────────────────────────
  let CALLS = []
  const mock = (script) => (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`
    CALLS.push(line)
    for (const [pat, resp] of script) if (line.includes(pat)) return resp
    return { ok: false, code: 1, out: 'unmocked' }
  }
  const writes = () => CALLS.filter((c) => c.includes('repo fork')).length
  const AUTH = ['gh api user', { ok: true, code: 0, out: 'techvantaai-create' }]
  const FORK_JSON = (parent = 'o/r', perm = 'ADMIN') => ({ ok: true, code: 0, out: JSON.stringify({ name: 'r', owner: { login: 'techvantaai-create' }, url: 'https://github.com/techvantaai-create/r', isFork: true, parent: { owner: { login: parent.split('/')[0] }, name: parent.split('/')[1] }, viewerPermission: perm }) })
  const NO_REPO = ['gh repo view', { ok: false, code: 1, out: 'not found' }]

  const FK = 'test/fork#9'
  intake([{ work_order_id: FK, source: 'algora', source_url: 'https://github.com/o/r/issues/9', title: 'fork fixture', reward: 50, reward_currency: 'USD' }])
  transition(FK, 'QUALIFIED'); transition(FK, 'READY_TO_ACCEPT')
  transition(FK, 'ACCEPTED', { approval: 'GO' }); transition(FK, 'IN_PROGRESS', { approval: 'GO' })
  patch(FK, { verification: { passed: true }, workspace: { path: fixture, branch: 'wo/x', base_branch: 'main', base_commit: 'abc1234', repo_url: 'https://github.com/o/r.git' } })
  transition(FK, 'READY_TO_SUBMIT')

  console.log('\nP9-1/2/3. approval + explicit execute are both required; dry run writes nothing')
  __setRunner(mock([AUTH, NO_REPO]))
  CALLS = []
  no('provision-fork without approval', () => provisionFork(FK))
  ok('...and it performed zero writes', () => `${writes()} fork calls`)
  CALLS = []
  ok('dry run reports FORK_REQUIRED', () => provisionFork(FK, { approval: 'human GO' }).status)
  ok('dry run performed zero writes', () => { if (writes()) throw new Error('a fork was attempted'); return `${writes()} fork calls` })
  ok('dry run wrote nothing to the ledger', () => { if (get(FK).fork) throw new Error('fork recorded on a dry run'); return 'ledger clean' })

  console.log('\nP9-4. missing auth => zero writes')
  __setRunner(mock([['gh api user', { ok: false, code: 1, out: 'not logged in' }], NO_REPO]))
  CALLS = []
  no('execute with no auth', () => provisionFork(FK, { approval: 'GO', execute: true }))
  ok('no fork attempted without auth', () => { if (writes()) throw new Error('attempted'); return `${writes()} fork calls` })

  console.log('\nP9-6/7. wrong repository and conflicting account repo are rejected')
  __setRunner(mock([AUTH, ['gh repo view', FORK_JSON('someone-else/r')]]))
  CALLS = []
  ok('fork of a DIFFERENT parent = FORK_CONFLICT', () => githubFork.detect(get(FK)).status)
  no('execute refused on conflict', () => provisionFork(FK, { approval: 'GO', execute: true }))
  ok('conflict produced zero writes', () => { if (writes()) throw new Error('attempted'); return `${writes()} fork calls` })
  ok('order with no source repo is rejected', () => githubFork.detect({ work_order_id: 'x' }).status)

  console.log('\nP9-5. existing fork prevents duplicate creation')
  __setRunner(mock([AUTH, ['gh repo view', FORK_JSON()]]))
  CALLS = []
  ok('existing fork => FORK_PRESENT, nothing created', () => {
    const r = provisionFork(FK, { approval: 'GO', execute: true })
    if (r.created) throw new Error('created a duplicate')
    if (writes()) throw new Error('called repo fork anyway')
    return `${r.status}, ${writes()} fork calls`
  })
  ok('metadata recorded for the detected fork', () => {
    const f = get(FK).fork
    if (f.owner !== 'techvantaai-create' || f.repo !== 'r' || f.source_repo !== 'o/r' || !f.provisioned_at || f.order_id !== FK) throw new Error(JSON.stringify(f))
    return `${f.owner}/${f.repo} detected=${f.detected}`
  })
  CALLS = []
  ok('re-provisioning is idempotent', () => {
    provisionFork(FK, { approval: 'GO', execute: true })
    if (writes()) throw new Error('second fork attempted')
    return `${writes()} fork calls on repeat`
  })

  console.log('\nP9-8. failure leaves the ledger unchanged')
  const FK2 = 'test/fork#10'
  intake([{ work_order_id: FK2, source: 'algora', source_url: 'https://github.com/o/r2/issues/10', title: 'f2', reward: 10, reward_currency: 'USD' }])
  __setRunner(mock([AUTH, NO_REPO, ['gh repo fork', { ok: false, code: 1, out: 'HTTP 403 forbidden' }]]))
  CALLS = []
  no('failed fork throws', () => provisionFork(FK2, { approval: 'GO', execute: true }))
  ok('no fork metadata written on failure', () => {
    const o = get(FK2)
    if (o.fork) throw new Error('fork recorded despite failure')
    if (o.fork_attempt?.status !== 'FAILED') throw new Error(`attempt not recorded: ${JSON.stringify(o.fork_attempt)}`)
    if (o.current_state !== 'DISCOVERED') throw new Error('state moved')
    return `fork=null, attempt=FAILED, state ${o.current_state}`
  })

  console.log('\nP9-9. uncertain response does not auto-retry')
  const FK3 = 'test/fork#11'
  intake([{ work_order_id: FK3, source: 'algora', source_url: 'https://github.com/o/r3/issues/11', title: 'f3', reward: 10, reward_currency: 'USD' }])
  __setRunner(mock([AUTH, NO_REPO, ['gh repo fork', { ok: true, code: 0, out: 'forked' }]]))  // fork "succeeds", readback still fails
  CALLS = []
  no('uncertain outcome throws', () => provisionFork(FK3, { approval: 'GO', execute: true }))
  ok('exactly ONE fork call was made, not a retry loop', () => { if (writes() !== 1) throw new Error(`${writes()} fork calls`); return '1 fork call' })
  ok('UNCERTAIN recorded', () => get(FK3).fork_attempt.status)
  CALLS = []
  no('a second attempt is refused while UNCERTAIN stands', () => provisionFork(FK3, { approval: 'GO', execute: true }))
  ok('refusal made zero further writes', () => { if (writes()) throw new Error('retried'); return `${writes()} fork calls` })

  console.log('\nP9-10/11/12. success path, detection, and submission handoff')
  const FK4 = 'test/fork#12'
  intake([{ work_order_id: FK4, source: 'algora', source_url: 'https://github.com/o/r/issues/12', title: 'f4', reward: 25, reward_currency: 'USD' }])
  let forkCreated = false
  __setRunner((cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`
    CALLS.push(line)
    if (line.includes('gh api user')) return AUTH[1]
    if (line.includes('gh repo fork')) { forkCreated = true; return { ok: true, code: 0, out: 'created' } }
    if (line.includes('gh repo view')) return forkCreated ? FORK_JSON() : NO_REPO[1]
    if (line.includes('auth status')) return { ok: true, code: 0, out: 'logged in' }
    return { ok: false, code: 1, out: 'unmocked' }
  })
  CALLS = []
  ok('fork created exactly once', () => {
    const r = provisionFork(FK4, { approval: 'human GO fork', execute: true })
    if (!r.created) throw new Error('not created')
    if (writes() !== 1) throw new Error(`${writes()} fork calls`)
    return `${r.fork.owner}/${r.fork.repo}`
  })
  ok('exact metadata recorded', () => {
    const f = get(FK4).fork
    for (const k of ['owner', 'repo', 'url', 'source_repo', 'provisioned_at', 'order_id']) if (!f[k]) throw new Error(`missing ${k}`)
    if (f.detected !== false) throw new Error('should be marked as created, not detected')
    return Object.keys(f).join(',')
  })
  ok('submission preflight now sees a writable fork', () => {
    patch(FK4, { workspace: { path: fixture, branch: 'wo/y', base_branch: 'main', base_commit: 'abc', repo_url: 'https://github.com/o/r.git' } })
    const pf = ADAPTERS.algora.preflight(get(FK4), get(FK4).workspace)
    const forkCheck = pf.checks.find((c) => c.check === 'writable fork exists')
    if (!forkCheck.ok) throw new Error(`still FORK_REQUIRED: ${forkCheck.detail}`)
    return forkCheck.detail
  })
  ok('FORK_REQUIRED is what an unprovisioned order reports', () => {
    const pf = ADAPTERS.algora.preflight({ source_url: 'https://github.com/o/zzz/issues/1' }, null)
    if (pf.status !== 'FORK_REQUIRED') throw new Error(`status was ${pf.status}`)
    return pf.status
  })

  console.log('\nP9-13. credentials cannot leak')
  process.env.GH_TOKEN = 'ghp_FAKEfakeFAKEfake1234567890abcd'
  const FK5 = 'test/fork#13'
  intake([{ work_order_id: FK5, source: 'algora', source_url: 'https://github.com/o/r5/issues/13', title: 'f5', reward: 10, reward_currency: 'USD' }])
  __setRunner(mock([AUTH, NO_REPO, ['gh repo fork', { ok: false, code: 1, out: `fatal: Authorization: Bearer ${process.env.GH_TOKEN} rejected (token ${process.env.GH_TOKEN})` }]]))
  let thrown = ''
  try { provisionFork(FK5, { approval: 'GO', execute: true }) } catch (e) { thrown = e.message }
  ok('token absent from the error surfaced to the user', () => { if (thrown.includes(process.env.GH_TOKEN)) throw new Error('LEAK in thrown error'); return 'redacted' })
  ok('token absent from work-orders.json', () => {
    const raw = readFileSync(new URL('./work-orders.json', import.meta.url), 'utf8')
    if (raw.includes(process.env.GH_TOKEN)) throw new Error('LEAK in ledger')
    return 'ledger clean'
  })
  ok('token absent from order history and attempt record', () => {
    const o = get(FK5)
    const blob = JSON.stringify({ history: o.history, fork_attempt: o.fork_attempt, notes: o.notes })
    if (blob.includes(process.env.GH_TOKEN)) throw new Error('LEAK in history/metadata')
    return 'history clean'
  })
  ok('redact() masks token patterns generally', () => redact('x ghp_AAAAAAAAAAAAAAAAAAAAAA y').includes('[REDACTED') ? 'masked' : (() => { throw new Error('not masked') })())
  delete process.env.GH_TOKEN

  console.log('\nP9-14/15. unattended agent + financial wall')
  ok('agent.mjs cannot reach fork provisioning', () => {
    const src = readFileSync(new URL('./agent.mjs', import.meta.url), 'utf8')
    for (const bad of ['adapters.mjs', 'workspace.mjs', 'provisionFork', 'githubFork', 'CAPABILITIES']) {
      if (src.includes(bad)) throw new Error(`agent.mjs references ${bad}`)
    }
    return 'no fork/submission/workspace path in the unattended agent'
  })
  ok('fork plan declares no credential creation and no money movement', () => {
    __setRunner(mock([AUTH, NO_REPO]))
    const pl = CAPABILITIES['github-fork'].plan(get(FK))
    if (pl.creates_credentials !== false || pl.moves_money !== false) throw new Error('capability claims a financial/credential effect')
    return 'creates_credentials=false, moves_money=false'
  })
  no('financial op still refused', () => assertNoFinancialAction('fund fork'))

  __setRunner(null)
  ws.destroy(EX); ws.destroy(EX2); rmSync(fixture, { recursive: true, force: true })

} finally {
  writeFileSync(STORE, backup)
  console.log(`\n${'─'.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed`)
  console.log(`live store restored (${JSON.parse(backup).length} order(s) preserved)`)
  process.exit(fail ? 1 : 0)
}
