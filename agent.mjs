/**
 * Always-on earning agent — runs on GitHub Actions cron (GitHub's servers, alive when the
 * home box is off). Dependency-free: Node 20+ global fetch only. Each run:
 *   1. reads on-chain balances of our receive-only wallets (real earnings show up here)
 *   2. scans Superteam's agent listings for new/open bounties we could win
 *   3. writes a timestamped status.md + appends history.jsonl, which the workflow commits
 *
 * Secrets (GitHub repo → Settings → Secrets): SUPERTEAM_API_KEY (optional; scan skipped without it).
 * No private keys ever live here — this process only READS. Earning/spending stays offline.
 */
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs'
// Discovery-safe surface only. `transition` is deliberately NOT imported — this process runs unattended
// every 30 minutes, so it must be structurally incapable of accepting or submitting work.
import { intake, normalize, summary as orderSummary, competitionBand } from './orders.mjs'

const EVM_WALLET = '0x9cc5612a9a3f27b374b6ff5efc95efa2be0193cb' // Base USDC receive-only
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const now = new Date().toISOString()

async function baseUsdc() {
  try {
    const r = await fetch('https://mainnet.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: BASE_USDC, data: '0x70a08231000000000000000000000000' + EVM_WALLET.slice(2) }, 'latest'],
      }),
    })
    const j = await r.json()
    return Number(BigInt(j.result || '0x0')) / 1e6
  } catch (e) { return `err:${e.message}` }
}

async function superteamLive() {
  const key = process.env.SUPERTEAM_API_KEY
  if (!key) return { skipped: 'no SUPERTEAM_API_KEY secret' }
  try {
    const r = await fetch('https://superteam.fun/api/agents/listings/live?take=50', {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const items = Array.isArray(d) ? d : d.result || []
    const open = items.filter((l) => (l.deadline || '9999') > now)
      // agentAccess is the competition signal: AGENT_ONLY listings are hidden from human feeds, so
      // they are the highest-odds money (past AGENT_ONLY rounds paid 3000–5000). Surface it + reward
      // so a low-competition high-value drop is obvious the moment it lands — no scorer needed at this
      // volume, just the two fields that decide whether a new listing is worth dropping everything for.
      .map((l) => ({ slug: l.slug, type: l.type, reward: l.rewardAmount, token: l.token, access: l.agentAccess, deadline: (l.deadline || '').slice(0, 10) }))
      .sort((a, b) => (b.access === 'AGENT_ONLY' ? 1 : 0) - (a.access === 'AGENT_ONLY' ? 1 : 0) || (b.reward || 0) - (a.reward || 0))
    return { total: items.length, open }
  } catch (e) { return { error: e.message } }
}

// Re-probe OpenTask each run: memory recorded its payment router as "unconfigured" (a dead rail). It
// exposes a machine-readable status per method — when any flips to "available", the rail is LIVE and
// we can act (and it lists x402-v2). This is a genuine net
// beyond Superteam: a second earning source we catch the instant it revives, without any signup.
async function openTaskRail() {
  try {
    const r = await fetch('https://opentask.ai/api/payment-methods', { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return { state: `HTTP ${r.status}` }
    const d = await r.json()
    const methods = Array.isArray(d.methods) ? d.methods : []
    const live = methods.filter((m) => m.status === 'available')
    return { state: live.length ? 'AVAILABLE' : 'unconfigured', live: live.map((m) => m.protocol) }
  } catch (e) { return { state: `err:${e.message}` } }
}

// dealwork.ai rail (registered 2026-07-05, agent echo-fable, autonomous onboard — the only other
// zero-signup work marketplace found in the 07-05 sweep). Three duties per run: (1) heartbeat so
// the platform shows us alive (buyers can filter dead agents), (2) watch our bids for acceptance,
// (3) watch contracts — an escrow_locked contract is REAL MONEY waiting on work, and the human's
// box may be off for days, so that event must escalate loudly, not sit in a feed nobody polls.
const DEALWORK_AGENT_ID = '648ac669-0f9e-4eef-8c95-624b51324a89'
async function dealworkRail() {
  const key = process.env.DEALWORK_API_KEY
  if (!key) return { skipped: 'no DEALWORK_API_KEY secret' }
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const out = {}
  try {
    // heartbeat is best-effort: a failure shouldn't hide bid/contract state below
    await fetch(`https://dealwork.ai/api/v1/agents/${DEALWORK_AGENT_ID}/heartbeat`, {
      method: 'POST', headers: H, body: JSON.stringify({ skillVersion: '1.4.0' }), signal: AbortSignal.timeout(10000),
    }).then((r) => { out.heartbeat = r.ok ? 'ok' : `HTTP ${r.status}` }).catch((e) => { out.heartbeat = `err:${e.message}` })
    const bids = await (await fetch('https://dealwork.ai/api/v1/bids/mine?per_page=20', { headers: H, signal: AbortSignal.timeout(10000) })).json()
    out.bids = (bids.data || []).map((b) => ({ id: b.id.slice(0, 8), job: (b.jobTitle || b.jobId || '').slice(0, 60), amount: b.proposedAmount, status: b.status }))
    const contracts = await (await fetch('https://dealwork.ai/api/v1/contracts?role=worker&per_page=20', { headers: H, signal: AbortSignal.timeout(10000) })).json()
    out.contracts = (contracts.data || []).map((c) => ({ id: c.id.slice(0, 8), state: c.state, amount: c.amount || c.escrowAmount }))
    out.actionable = out.contracts.filter((c) => ['escrow_locked', 'in_progress'].includes(c.state)).length
    return out
  } catch (e) { return { error: e.message, ...out } }
}

// toku.agency rail (registered 2026-07-10, agent echo-fable, autonomous onboard — pays real USD to
// a platform wallet; Stripe onboarding is only needed at withdrawal, same claim-at-end shape as
// Superteam). No webhook infra on our side, so poll the wallet: a balanceCents rise means someone
// actually hired/paid us and that must escalate loudly, not sit unread in a platform inbox.
async function tokuRail() {
  const key = process.env.TOKU_API_KEY
  if (!key) return { skipped: 'no TOKU_API_KEY secret' }
  try {
    const r = await fetch('https://www.toku.agency/api/agents/wallet', {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    // unread notifications = a hire or DM waiting; the platform has no push to us, so poll it here
    let unread = 0
    try {
      const n = await (await fetch('https://www.toku.agency/api/agents/notifications', {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
      })).json()
      unread = n.unreadCount || 0
    } catch {}
    return { balanceCents: d.balanceCents ?? 0, txs: (d.transactions || []).length, unread }
  } catch (e) { return { error: e.message } }
}

// GitHub PR watch (2026-07-05): our first real ugig rail is profullstack's pay-per-merged-PR bounty.
// Payment is OFF-platform + manual — he pays only AFTER a PR merges AND we send an invoice on ugig
// (no escrow guarantees it; the wallet watcher above catches the money itself). So we must catch the
// MERGE transition to trigger the invoice step, or a merged PR sits unbilled forever. Searches our
// authored PRs across the profullstack org; merged = pull_request.merged_at set. Fires once on a rise.
async function githubPrs() {
  try {
    const q = encodeURIComponent('author:techvantaai-create type:pr org:profullstack')
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'echo-earning-agent' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=50`, { headers, signal: AbortSignal.timeout(10000) })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const prs = (d.items || []).map((p) => ({
      repo: (p.repository_url || '').split('/').pop(),
      num: p.number,
      title: (p.title || '').slice(0, 50),
      merged: Boolean(p.pull_request && p.pull_request.merged_at),
      state: p.state,
    }))
    return { total: prs.length, merged: prs.filter((p) => p.merged).length, prs }
  } catch (e) { return { error: e.message } }
}

// Algora early-bounty sensor (2026-09-15). Funding is rarely what kills an OSS bounty — the merge path
// is, and it dies once a bounty ages long enough to draw 20+ agent-written PRs onto one issue (observed:
// 31 PRs, 0 merged, maintainer disengaged). The only edge left is TIME, so watch for bounties in their
// first days while the review queue is still empty. DETECTION ONLY: three GET calls, no claim path, and
// anything it cannot establish cheaply is reported NOT_CHECKED rather than guessed.
const ALGORA_FRESH_DAYS = 14     // a bounty older than this has usually already drawn a PR swarm
const ALGORA_ENRICH_MAX = 8      // per-issue comment reads per run
const ALGORA_REPO_CHECK_MAX = 3  // per-repo merge-activity reads per run
async function algoraFresh() {
  const H = { Accept: 'application/vnd.github+json', 'User-Agent': 'echo-earning-agent' }
  // reuses the workflow's auto-injected GITHUB_TOKEN when present; never required, never stored
  if (process.env.GITHUB_TOKEN) H.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const get = async (u) => {
    const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }
  try {
    // A bounty is a COMMENT, usually posted onto an issue that is already months or years old, so
    // filtering by issue `created:` misses nearly every real bounty (measured: 0 hits over 120 days
    // while live bounties existed). Search cannot filter by comment date, so sort by recent activity
    // and derive true bounty age from the bot comment timestamp during enrichment below.
    const q = encodeURIComponent('is:issue is:open commenter:algora-pbc')
    const j = await get(`https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=30`)
    const items = j.items || []
    const cands = []
    for (const it of items.slice(0, ALGORA_ENRICH_MAX)) {
      const repo = (it.repository_url || '').replace(/.*\/repos\//, '')
      const c = {
        repo, num: it.number, url: it.html_url, title: (it.title || '').slice(0, 60),
        issueAgeDays: Math.floor((Date.now() - Date.parse(it.created_at)) / 86400000), // NOT bounty age
        bountyUsd: null, cancelled: false, attempts: null, competition: 'UNKNOWN',
        maintainer: 'UNKNOWN', lastExternalMerge: null, externalMerges30d: null,
        // this rail never establishes these — a human/session step does, or they stay unknown
        payout: 'NOT_CHECKED', zeroCost: 'NOT_CHECKED', ai: 'NOT_CHECKED',
      }
      try {
        const cm = await get(`https://api.github.com/repos/${repo}/issues/${it.number}/comments?per_page=100`)
        const bot = cm.filter((x) => x.user && x.user.login === 'algora-pbc').pop()
        // a struck-through bounty comment (~~...~~) means the sponsor pulled it — not a live reward
        c.cancelled = Boolean(bot && /~~/.test(bot.body || ''))
        // the real freshness signal: when the BOUNTY was posted, not when the issue was opened
        c.bountyPostedAt = bot ? bot.created_at : null
        c.bountyAgeDays = bot ? Math.floor((Date.now() - Date.parse(bot.created_at)) / 86400000) : null
        c.fresh = c.bountyAgeDays != null && c.bountyAgeDays <= ALGORA_FRESH_DAYS
        const m = (bot && (bot.body || '').match(/\$\s?([\d,]+(?:\.\d{1,2})?)/)) || null
        c.bountyUsd = m ? Number(m[1].replace(/,/g, '')) : null
        c.attempts = cm.filter((x) => /\/attempt|\/claim/i.test(x.body || '')).length
        c.competition = competitionBand(c.attempts) // a BAND, never a filter
      } catch (e) { c.enrichError = e.message }
      cands.push(c)
    }
    // Ordinary-PR activity and bounty-PR activity are SEPARATE signals (a repo can merge externals daily
    // and still leave every bounty PR unreviewed), so this measures the repo pulse only — not the odds.
    cands.sort((a, b) => (a.bountyAgeDays ?? 1e9) - (b.bountyAgeDays ?? 1e9))
    for (const c of cands.slice(0, ALGORA_REPO_CHECK_MAX)) {
      try {
        const owner = c.repo.split('/')[0]
        const q = encodeURIComponent(`repo:${c.repo} is:pr is:merged`)
        const j = await get(`https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=30`)
        const ext = (j.items || []).filter((x) => x.user && x.user.login !== owner && x.closed_at)
        c.lastExternalMerge = ext.length ? ext[0].closed_at.slice(0, 10) : null
        const cut = Date.now() - 30 * 86400000
        c.externalMerges30d = ext.filter((x) => Date.parse(x.closed_at) >= cut).length
        c.maintainer = c.externalMerges30d >= 3 ? 'ACTIVE' : c.externalMerges30d >= 1 ? 'MODERATELY_ACTIVE' : ext.length ? 'STALE' : 'UNKNOWN'
      } catch (e) { c.mergeError = e.message }
    }
    return { freshDays: ALGORA_FRESH_DAYS, scanned: items.length, enriched: cands.length, fresh: cands.filter((c) => c.fresh).length, candidates: cands }
  } catch (e) { return { error: e.message } }
}

// Watch a listing WE have actually entered — it drops off the "live" feed after its deadline, but
// we still need to catch the winners announcement. Inert until we submit something: set the slug,
// and the claim code the platform issues us, below. Never point this at someone else's entry — the
// claim code is how a human collects the money.
const SUPERTEAM_SUBMISSION_SLUG = null
const SUPERTEAM_CLAIM_CODE = null
async function hackathonStatus() {
  if (!SUPERTEAM_SUBMISSION_SLUG) return { skipped: 'no submission configured' }
  const key = process.env.SUPERTEAM_API_KEY
  if (!key) return { skipped: true }
  try {
    const r = await fetch(`https://superteam.fun/api/agents/listings/details/${SUPERTEAM_SUBMISSION_SLUG}`, { headers: { Authorization: `Bearer ${key}` } })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const l = d.listing || d
    return { status: l.status, isActive: l.isActive, winnersAnnounced: l.isWinnersAnnounced ?? l.winnersAnnouncedAt ?? null }
  } catch (e) { return { error: e.message } }
}

// Solana-side USDC (second payment rail added 2026-07-05; receive-only wallet).
const SOL_WALLET = 'JBXZT9DcbmZSqAbDRB7U7uSYeFZyjerVB3cCAX1DVsFR'
async function solUsdc() {
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
        params: [SOL_WALLET, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, { encoding: 'jsonParsed' }],
      }),
    })
    const j = await r.json()
    return (j?.result?.value ?? []).reduce((s, a) => s + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0), 0)
  } catch (e) { return `err:${e.message}` }
}

// Native SOL balance — chovy's ugig bounties pay in NATIVE SOL (payment_coin: "SOL"), which the
// USDC token-account query above never sees. Bounty submission 7895935a (sh1pt PR #763) pays here.
async function solNative() {
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOL_WALLET] }),
    })
    const j = await r.json()
    return (j?.result?.value ?? 0) / 1e9
  } catch (e) { return `err:${e.message}` }
}

const usdc = await baseUsdc()
const solUsdcBal = await solUsdc()
const solNativeBal = await solNative()
const superteam = await superteamLive()
const openTask = await openTaskRail()
const hackathon = await hackathonStatus()
const dealwork = await dealworkRail()
const toku = await tokuRail()
const github = await githubPrs()
const algora = await algoraFresh()

// DISCOVERY ONLY: records what the sensor saw as DISCOVERED work orders. Creating a row is not
// accepting a job — advancing past DISCOVERED happens exclusively through the human CLI in orders.mjs.
// Cancelled bounties are never taken in. Competition is carried as a risk flag, never as a filter.
// DISCOVERY ONLY, one schema for every rail. Creating a row is not accepting a job — advancing past
// DISCOVERED happens exclusively through the human CLI in orders.mjs. Cancelled bounties are never
// taken in. Competition rides along as a risk flag and a score penalty, never as a filter.
// Rails that only report status (dealwork bids/contracts, toku wallet, opentask router, our own PRs)
// emit no opportunities by design: they monitor money and work we already hold.
const discovered = intake([
  ...(algora.candidates || []).filter((c) => !c.cancelled).map((c) => normalize('algora', c)),
  ...(superteam.open || []).map((l) => normalize('superteam', l)),
].filter(Boolean))
const orders = orderSummary()

// Balance delta vs the previous run — a payment landing is THE profit event, so flag it loudly
// instead of leaving it as a quietly-changed number nobody reads. Also carry forward the previous
// winners state so we can notify only on the TRANSITION (fire once, not every run forever).
let prevUsdc = null, prevSol = null, prevSolNative = null, prevWinners = false, prevActionable = 0, prevMerged = 0, prevTokuCents = null
try {
  const lines = readFileSync(new URL('./history.jsonl', import.meta.url), 'utf8').trim().split('\n')
  if (lines.length) { const p = JSON.parse(lines[lines.length - 1]); if (typeof p.baseUsdc === 'number') prevUsdc = p.baseUsdc; if (typeof p.solUsdc === 'number') prevSol = p.solUsdc; if (typeof p.solNative === 'number') prevSolNative = p.solNative; prevWinners = Boolean(p.winnersFired); prevActionable = p.dealwork?.actionable || 0; prevMerged = p.github?.merged || 0; if (typeof p.toku?.balanceCents === 'number') prevTokuCents = p.toku.balanceCents }
} catch {}
const delta = (typeof usdc === 'number' && typeof prevUsdc === 'number') ? usdc - prevUsdc : 0
// ugig's PREFERRED payout is usdc_sol, so a real payment most likely lands on Solana — diff it too or
// the most-likely money event would change a number nobody's alerted to. Same transition-only rule.
const solDelta = (typeof solUsdcBal === 'number' && typeof prevSol === 'number') ? solUsdcBal - prevSol : 0
const solNativeDelta = (typeof solNativeBal === 'number' && typeof prevSolNative === 'number') ? solNativeBal - prevSolNative : 0
// A dealwork contract appearing means a bid was ACCEPTED and escrow is locked — work is owed and
// paid-for. Same transition-only alert discipline as payments: fire once when the count rises.
const newContract = (dealwork.actionable || 0) > prevActionable
// A PR just merged → the bounty is now billable; we must send the invoice on ugig. Fire once on a rise.
const newMerge = (github.merged || 0) > prevMerged
// toku wallet is platform-custodied USD cents; a rise = someone paid for our work there. Transition-only.
const tokuDelta = (typeof toku.balanceCents === 'number' && typeof prevTokuCents === 'number') ? toku.balanceCents - prevTokuCents : 0

// Robust winners watch: this fires exactly once, after Jul 6, and CANNOT be tested until then — so
// treat ANY truthy signal as fired and shout. This is the $500–3000 event; it must not fail quietly.
const winnersFired = Boolean(hackathon.winnersAnnounced)
// Notify the human ONLY on the transition into a real event (winners just announced, or money just
// landed) — the workflow turns this sentinel into a failed run, which GitHub emails the repo owner.
// Writing it only on the transition means one email, not a failure on every subsequent run.
const justWon = winnersFired && !prevWinners
const notify = justWon || delta > 0 || solDelta > 0 || solNativeDelta > 0 || newContract || newMerge || tokuDelta > 0

// remember which listing slugs we have already seen, so we can flag genuinely NEW ones
let seen = []
try { seen = JSON.parse(readFileSync(new URL('./seen-listings.json', import.meta.url), 'utf8')) } catch {}
const openSlugs = (superteam.open || []).map((o) => o.slug)
const fresh = openSlugs.filter((s) => !seen.includes(s))
const freshDetail = (superteam.open || []).filter((o) => fresh.includes(o.slug))
writeFileSync(new URL('./seen-listings.json', import.meta.url), JSON.stringify([...new Set([...seen, ...openSlugs])], null, 0))

let seenAlgora = []
try { seenAlgora = JSON.parse(readFileSync(new URL('./seen-algora.json', import.meta.url), 'utf8')) } catch {}
const algoraKeys = (algora.candidates || []).map((c) => `${c.repo}#${c.num}`)
const algoraNew = (algora.candidates || []).filter((c) => !seenAlgora.includes(`${c.repo}#${c.num}`))
writeFileSync(new URL('./seen-algora.json', import.meta.url), JSON.stringify([...new Set([...seenAlgora, ...algoraKeys])], null, 0))

const snapshot = { ts: now, baseUsdc: usdc, solUsdc: solUsdcBal, solNative: solNativeBal, delta, solDelta, solNativeDelta, openTask, hackathon, winnersFired, dealwork, toku, github, superteam, algora, orders, discovered: discovered.map((d) => d.work_order_id), newListings: fresh }
appendFileSync(new URL('./history.jsonl', import.meta.url), JSON.stringify(snapshot) + '\n')

const md = `# Earning agent status

_Last run: ${now} (UTC), ${process.env.GITHUB_ACTIONS ? "on GitHub Actions" : "locally"}._

## 💰 Wallet (real earnings land here)
- **Base USDC** \`${EVM_WALLET}\`: **${usdc}**${delta > 0 ? ` · 🎉 **+${delta.toFixed(6)} received since last run!**` : ''}
- **Solana USDC** \`${SOL_WALLET}\`: **${solUsdcBal}**${solDelta > 0 ? ` · 🎉 **+${solDelta.toFixed(6)} received since last run!**` : ''}
- **Solana (native SOL — chovy's bounties pay here)**: **${solNativeBal}**${solNativeDelta > 0 ? ` · 🎉 **+${solNativeDelta.toFixed(9)} SOL received since last run!**` : ''}

## 🔀 Alt rails (widening the net beyond Superteam)
- **OpenTask** router: **${openTask.state}**${openTask.live?.length ? ` · LIVE methods: ${openTask.live.join(', ')} — ACT NOW` : ' _(watching for revival)_'}
- **dealwork.ai** (agent echo-fable): ${dealwork.skipped ? `_${dealwork.skipped}_` : dealwork.error ? `_err: ${dealwork.error}_` : `heartbeat **${dealwork.heartbeat}** · bids: ${dealwork.bids?.map((b) => `${b.status} $${b.amount}`).join(', ') || 'none'} · contracts: ${dealwork.contracts?.length ? dealwork.contracts.map((c) => `${c.state} $${c.amount ?? '?'}`).join(', ') : 'none'}${dealwork.actionable ? ' · ⚡ **ESCROW LOCKED — WORK IS OWED, open a session**' : ''}`}
- **toku.agency** (agent echo-fable, real-USD wallet): ${toku.skipped ? `_${toku.skipped}_` : toku.error ? `_err: ${toku.error}_` : `balance **$${((toku.balanceCents || 0) / 100).toFixed(2)}** · ${toku.txs} transactions · ${toku.unread || 0} unread${toku.unread ? ' · 📬 **UNREAD NOTIFICATION — possible hire/DM, open a session**' : ''}${tokuDelta > 0 ? ` · 🎉 **+$${(tokuDelta / 100).toFixed(2)} earned since last run!**` : ''}`}

## 🔧 profullstack PR bounties (pay-per-merged-PR on ugig; invoice required after merge)
- ${github.error ? `_err: ${github.error}_` : github.prs?.length ? `${github.merged}/${github.total} merged · ${github.prs.map((p) => `${p.merged ? '✅' : p.state === 'closed' ? '❌' : '⏳'} ${p.repo}#${p.num}`).join(', ')}${newMerge ? ' · 💵 **A PR JUST MERGED — SEND THE INVOICE ON ugig NOW**' : ''}` : '_no PRs found yet_'}

## 🏆 Submitted listing watch
- ${!SUPERTEAM_SUBMISSION_SLUG ? '_no submission of our own configured — watcher inert_' : `\`${SUPERTEAM_SUBMISSION_SLUG}\` — listing status: **${hackathon.status ?? hackathon.error ?? 'n/a'}**${winnersFired ? ` · 🏆 **WINNERS ANNOUNCED${SUPERTEAM_CLAIM_CODE ? ` — CHECK CLAIM: superteam.fun/earn/claim/${SUPERTEAM_CLAIM_CODE}` : ' — check the listing for the claim link'}**` : ''}`}

## 🧾 Work order queue (advance only via \`node orders.mjs\` \u2014 ACCEPT/SUBMIT need human GO)
- ${orders.total} tracked \u00b7 ${orders.active} active \u00b7 ${Object.entries(orders.byState).map(([k, v]) => `${k}: ${v}`).join(' \u00b7 ') || '_none_'}${discovered.length ? ` \u00b7 \ud83c\udd95 **${discovered.length} newly discovered**` : ''}

## 🆕 Algora bounty radar (fresh = bounty posted \u2264${algora.freshDays}d ago \u2014 DETECTION ONLY, nothing below is verified)
${algora.error ? `_err: ${algora.error}_` : algora.candidates && algora.candidates.length ? algora.candidates.map((c) => `- [${c.repo}#${c.num}](${c.url}) \u2014 **${c.bountyUsd != null ? '$' + c.bountyUsd : 'amount ?'}**${c.cancelled ? ' \u26a0\ufe0f **CANCELLED**' : ''} \u00b7 bounty ${c.bountyAgeDays != null ? c.bountyAgeDays + 'd' : '?'} old${c.fresh ? ' \u2728 **FRESH**' : ''} \u00b7 competition **${c.competition}**${c.attempts != null ? ` (${c.attempts} attempts)` : ''} \u00b7 maintainer **${c.maintainer}**${c.lastExternalMerge ? ` (last ext merge ${c.lastExternalMerge})` : ''} \u00b7 payout _${c.payout}_ \u00b7 $0 _${c.zeroCost}_`).join('\n') : '_none in window_'}

## 🎯 Open agent listings (Superteam) — AGENT_ONLY first (lowest competition)
${superteam.skipped ? `_scan skipped: ${superteam.skipped}_`
  : superteam.error ? `_scan error: ${superteam.error}_`
  : (superteam.open?.length
      ? superteam.open.map((o) => `- ${o.access === 'AGENT_ONLY' ? '🔒 **AGENT_ONLY**' : 'open'} · \`${o.slug}\` — ${o.type} · ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')
      : '_none open right now_')}

${fresh.length ? `## 🆕 New since last run\n${freshDetail.map((o) => `- ${o.access === 'AGENT_ONLY' ? '🔒 AGENT_ONLY' : 'open'} · \`${o.slug}\` — ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')}` : ''}

---
_This file is rewritten by \`agent.mjs\` on every scheduled run. History in \`history.jsonl\`._
`
writeFileSync(new URL('./status.md', import.meta.url), md)

// The notification sentinel: present ONLY on a transition run. The workflow's final step fails the
// run when it exists (→ GitHub emails the repo owner), then it's cleared on the next run so a single
// event produces a single alert. This is our no-signup push channel; the human also has the always-
// current status.md and can just ask. Written AFTER status.md so a commit still captures state.
const NOTIFY = new URL('./NOTIFY.txt', import.meta.url)
if (notify) {
  const msg = justWon
    ? `🏆 WINNERS ANNOUNCED (${now}) — ${SUPERTEAM_CLAIM_CODE ? `claim at superteam.fun/earn/claim/${SUPERTEAM_CLAIM_CODE}` : 'check the listing for the claim link'}`
    : (delta > 0 || solDelta > 0 || solNativeDelta > 0)
    ? `💰 PAYMENT RECEIVED (${now}) — ${delta > 0 ? `+${delta.toFixed(6)} USDC on Base (total ${usdc})` : ''}${delta > 0 && solDelta > 0 ? ' + ' : ''}${solDelta > 0 ? `+${solDelta.toFixed(6)} USDC on Solana (total ${solUsdcBal})` : ''}${solNativeDelta > 0 ? ` +${solNativeDelta.toFixed(9)} native SOL (total ${solNativeBal})` : ''}`
    : tokuDelta > 0
    ? `💰 TOKU PAYMENT (${now}) — +$${(tokuDelta / 100).toFixed(2)} in the toku.agency wallet (total $${((toku.balanceCents || 0) / 100).toFixed(2)}); withdrawal needs one-time Stripe onboarding`
    : newMerge
    ? `💵 PR MERGED (${now}) — a profullstack PR was merged; send the invoice on ugig now to get paid`
    : newContract
    ? `⚡ DEALWORK BID ACCEPTED (${now}) — escrow locked, work is owed; open a Claude session to deliver`
    : `event (${now})`
  writeFileSync(NOTIFY, msg + '\n')
} else {
  try { unlinkSync(NOTIFY) } catch {}
}

console.log('status:', JSON.stringify(snapshot))
// Loud CI signals for the events that actually matter — these surface in the Actions run summary.
if (delta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${delta.toFixed(6)} USDC landed on Base — total ${usdc}`)
if (solDelta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${solDelta.toFixed(6)} USDC landed on Solana — total ${solUsdcBal}`)
if (solNativeDelta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${solNativeDelta.toFixed(9)} native SOL landed — total ${solNativeBal}`)
if (newMerge) console.log('::notice title=PR MERGED::a profullstack PR merged — send the invoice on ugig now')
if (winnersFired) console.log(`::notice title=WINNERS ANNOUNCED::${SUPERTEAM_CLAIM_CODE ? `claim at superteam.fun/earn/claim/${SUPERTEAM_CLAIM_CODE}` : 'check the listing for the claim link'}`)
if (openTask.live?.length) console.log(`::notice title=OPENTASK RAIL LIVE::methods ${openTask.live.join(', ')} — a new earning source just opened`)
if (newContract) console.log('::notice title=DEALWORK BID ACCEPTED::escrow locked — work is owed, open a session to deliver')
if (tokuDelta > 0) console.log(`::notice title=TOKU PAYMENT::+$${(tokuDelta / 100).toFixed(2)} USD landed in the toku.agency wallet — total $${((toku.balanceCents || 0) / 100).toFixed(2)}`)
if (toku.unread) console.log(`::notice title=TOKU UNREAD::${toku.unread} unread toku notification(s) — possible hire or DM`)
const algoraAlert = algoraNew.filter((c) => c.fresh && !c.cancelled)
if (algoraAlert.length) console.log('::notice title=NEW ALGORA BOUNTY::' + algoraAlert.map((c) => `${c.repo}#${c.num} ${c.bountyUsd != null ? '$' + c.bountyUsd : '$?'} (competition ${c.competition}, maintainer ${c.maintainer}) \u2014 VERIFY payout + $0 before any work`).join(' | '))
if (freshDetail.length) console.log('::notice title=NEW LISTINGS::' + freshDetail.map((o) => `${o.slug} (${o.access}, ${o.reward} ${o.token})`).join(' | '))
