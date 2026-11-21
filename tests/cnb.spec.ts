import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { key, type Thread, type Trigger } from '../src/core/index.ts'
import { commentTrigger, ciTrigger, branchCiTrigger, cnbAddress, cnbChannel, cnbPage,
  type CnbComment, type CnbIssue, isHumanUser, issueTrigger, mentions, pullEnded, pullTrigger, reviewPlace }
  from '../src/sources/cnb-trigger.ts'
import { ciCounts, ciFact, ciSummary, commitStatuses, readCnb, cnbThreadContext, CommitStatusesSchema } from '../src/sources/cnb-read.ts'
import { claimPull, observePull, pullEndNotices, pullsOf, type Pull } from '../src/sources/cnb-pull.ts'
import { cnbLink, sendCnb } from '../src/sources/cnb-channel.ts'
import { cnbKind, pollFailure, pollRound, pollTicketPulls, pollThreads, runCnb } from '../src/sources/cnb.ts'
import { apply as applyCnb } from '../src/sources/cnb.ts'
import { z } from 'zod'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'

const REPO = 'acme/widgets'
const PAGE = (number: string, pr: boolean) => `https://cnb.cool/${REPO}/-/${pr ? 'pulls' : 'issues'}/${number}`
const envelope = (data: unknown): string => JSON.stringify({ status: 200, data })
const gone = (): Error => commandError({ stderr: '{"error":{"code":410,"message":"Gone"}}', code: 1 })
const refused = (status: number, text: string): Error => commandError({ stderr: `cnb: ${text} (HTTP ${status})`, code: 1 })

/** A trigger whose CI timestamp is not stable; other fields must still match exactly. */
const anyAt = { at: expect.any(String) }

function host(overrides: Partial<SourceContextDeps> = {}, options: { enabled?: boolean; config?: Record<string, unknown>; register?: boolean } = {}) {
  const enabled = options.enabled ?? true
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'cnb-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { cnb: { allowed: [{ id: 'alice' }] } } },
    sources: { cnb: { enabled, config: { repository: REPO, cli: '/bin/true', ...options.config } } },
  })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (options.register !== false) sources.register(cnbKind)
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({
    repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: (message: OutboundMessage) => { store.receipts.add(message) }, status: () => undefined, withdraw: () => {} },
  })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: (message: OutboundMessage) => { store.receipts.add(message) } },
    commands, sources, deployment, ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ...value, ...sourceContextOf(parts, { kind: 'cnb', health: ['cnb'] }), board, store, engine, commands, receive }
}

/** The subscribed thread fixture pollThreads walks; recent activity keeps it inside the polling horizon. */
function subscribed(h: ReturnType<typeof host>, id: string, meta: Record<string, unknown> = {}): Thread {
  const ref = { source: 'cnb', id }
  const thread: Thread = { key: `cnb:${id}`, ref, createdAt: new Date().toISOString(), subscriptions: ['t1'], correlated: [], pending: [], meta }
  h.store.threads.save(thread)
  return thread
}

/** One open ticket whose execution branch matches `agent/<name>`, as claimPull's branch rule requires. */
function ticket(h: ReturnType<typeof host>, id: string, extra: Partial<Ticket> = {}): Ticket {
  return { id, title: id, decisionId: `d-${id}`,
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'cnb', id: 'alice' }, scope: '' },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: { name: id, directory: `/w/${id}`, assignment: '' },
    origin: { triggerId: `source-${id}`, triggerIds: [] }, ...extra }
}

/** The PR fixture shape every cnb read returns; cnb numbers are strings and authors use `username`. */
const openPull = (number: string, overrides: Record<string, unknown> = {}): Pull =>
  ({ number, title: `PR ${number}`, state: 'open', author: { username: 'alice', nickname: 'Alice', is_npc: false },
    head: { ref: 'main', sha: 'abc1234', path: REPO }, base: { ref: 'main', sha: 'def5678' }, created_at: '2026-09-01T00:00:00Z', ...overrides })
const agentPullFixture = (number: string, branch: string): Pull =>
  ({ ...openPull(number), author: { username: 'agent-bot', nickname: null, is_npc: false }, head: { ref: branch, sha: 'abc1234', path: REPO } })
const endedPull = (number: string, at: string, merged = true): Pull =>
  ({ ...openPull(number), state: merged ? 'merged' : 'closed', is_merged: merged, closed_at: at })

const statuses = (sha: string, entries: { context: string; state: string }[]): Record<string, unknown> =>
  ({ sha, statuses: entries.map(({ context, state }) => ({ context, state, description: `${context} ${state}` })) })
const CI_OK = statuses('abc1234def5678', [{ context: 'build', state: 'success' }])

/** Stubs every cnb CLI read the polls make; `git get-head` names `main`. Routes may be values or `(args: string[]) => unknown` functions. */
function stubCnb(h: ReturnType<typeof host>, routes: Record<string, unknown | ((args: string[]) => unknown)> = {}, calls: string[][] = []): void {
  // Spying on the prototype covers the `withSignal` copies the polling loops read through.
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async function (this: Commands, _program: string, args: string[]) {
    calls.push(args)
    const key = `${args[0]} ${args[1]}`
    const route = routes[key]
    if (route === undefined) throw new Error(`Unexpected cnb call: ${key} ${JSON.stringify(args)}`)
    const data = typeof route === 'function' ? (route as (args: string[]) => unknown)(args) : route
    return envelope(data)
  })
}

const reviewComment = (overrides: Partial<CnbComment> = {}): CnbComment =>
  ({ id: 'c1', body: 'please fix', author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-01T00:00:00Z',
    path: 'src/a.ts', start_line: 3, end_line: 5, diff_hunk: [{ content: '+ const x = 1' }], ...overrides })

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-09-02T00:00:00Z'), toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('cnb triggers', () => {
  it('builds a conversation comment trigger with its channel and mention flag', () => {
    const ref = { number: '7', isPr: false, url: PAGE('7', false) }
    const trigger = commentTrigger({ id: 'cm_9', body: 'hello @agent-bot look', author: { username: 'alice', nickname: null, is_npc: false },
      created_at: '2026-09-01T01:00:00Z', updated_at: '2026-09-01T02:00:00Z' }, ref, 'conversation', 'agent-bot')
    expect(trigger).toEqual({ id: key('cnb-comment', 'cnb:7', 'cm_9', '2026-09-01T02:00:00Z'), source: 'cnb',
      threads: [{ source: 'cnb', id: '7' }], actor: { source: 'cnb', id: 'alice' }, human: true, at: '2026-09-01T02:00:00Z',
      text: 'hello @agent-bot look', addressed: 'mention',
      channel: { source: 'cnb', thread: 'cnb:7', address: { number: '7', url: PAGE('7', false) } }, url: PAGE('7', false),
      meta: { number: '7', isPr: false, commentId: 'cm_9', kind: 'conversation' } })
    expect(commentTrigger({ id: 'cm_9', body: 'plain', author: { username: 'alice', nickname: null, is_npc: false },
      created_at: '2026-09-01T01:00:00Z' }, ref, 'conversation', 'agent-bot').addressed).toBeUndefined()
  })

  it('builds inline and review triggers, and keeps ids stable for bodyless comments', () => {
    const ref = { number: '7', isPr: true, url: PAGE('7', true), prAuthor: 'alice' }
    const inline = commentTrigger(reviewComment({ id: 'rc_1', review_id: 'rv_1' }), ref, 'inline', 'agent-bot')
    expect(inline).toEqual({ id: key('cnb-comment', 'cnb:7', 'rc_1', ''), source: 'cnb', threads: [{ source: 'cnb', id: '7' }],
      actor: { source: 'cnb', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'src/a.ts:3-5\n+ const x = 1\n\nplease fix',
      channel: { source: 'cnb', thread: 'cnb:7', address: { number: '7', pr: '1', review: 'rv_1', url: PAGE('7', true) } }, url: PAGE('7', true),
      meta: { number: '7', isPr: true, prAuthor: 'alice', commentId: 'rc_1', kind: 'inline', reviewId: 'rv_1', path: 'src/a.ts', line: 3 } })
    const review = commentTrigger({ id: 'rv_1', body: '', review_state: 'approved', commit_hash: 'abc1234',
      author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-01T03:00:00Z' }, ref, 'review', 'agent-bot')
    expect(review.text).toBe('approved review of commit abc1234')
    expect(review.meta.reviewId).toBe('rv_1')
    expect(commentTrigger(reviewComment({ id: 'rc_2', body: '' }), ref, 'inline', 'agent-bot').text).toBe('')
  })

  it('builds issue and pull triggers with a fallback author', () => {
    const issue: CnbIssue = { number: '5', title: 'Broken thing', body: 'see steps',
      author: { username: 'dave', nickname: null, is_npc: false }, created_at: '2026-09-01T00:00:00Z' }
    expect(issueTrigger(issue, 'agent-bot', PAGE('5', false))).toEqual({ id: key('cnb-issue', '5'), source: 'cnb',
      threads: [{ source: 'cnb', id: '5' }], actor: { source: 'cnb', id: 'dave' }, human: true, at: '2026-09-01T00:00:00Z',
      text: 'Broken thing\n\nsee steps', channel: { source: 'cnb', thread: 'cnb:5', address: { number: '5', url: PAGE('5', false) } },
      url: PAGE('5', false), meta: { number: '5', isPr: false, kind: 'issue' } })
    const opened = issueTrigger({ ...issue, author: { username: 'agent-bot', nickname: null, is_npc: false } }, 'agent-bot')
    expect(opened.human).toBe(false)
    const pull = pullTrigger({ ...issue, number: '6' }, 'agent-bot', PAGE('6', true))
    expect(pull.id).toBe(key('cnb-issue', '6'))
    expect(pull.meta).toEqual({ number: '6', isPr: true, prAuthor: 'dave', kind: 'pull' })
    expect(pullTrigger({ ...issue, number: '6', author: { username: 'alice', nickname: null, is_npc: false } }, 'agent-bot').meta.prAuthor).toBe('alice')
  })

  it('marks bot authors and mentions only whole words', () => {
    expect(isHumanUser({ username: 'alice', nickname: null, is_npc: false })).toBe(true)
    expect(isHumanUser({ username: 'alice', nickname: null, is_npc: true })).toBe(false)
    expect(isHumanUser({ username: 'cnb-ai', nickname: null, is_npc: false })).toBe(false)
    expect(isHumanUser({ username: 'dsh-superagent', nickname: null, is_npc: null })).toBe(false)
    expect(mentions('hey @Agent-Bot!', 'agent-bot')).toBe(true)
    expect(mentions('@agent-botx', 'agent-bot')).toBe(false)
    expect(mentions('mail me at someone@agent-bot', 'agent-bot')).toBe(false)
  })

  it('builds CI triggers; the branch trigger has no channel and the PR trigger carries one', () => {
    const branch = branchCiTrigger('main', 'abc1234', 2, 'CI passed 1/1 at abc1234\nRead cnb/branches/main/checks for every check.',
      `https://cnb.cool/${REPO}/-/commit/abc1234`)
    expect(branch).toEqual({ id: key('cnb-ci', 'branch:main', '2'), source: 'cnb', threads: [{ source: 'cnb', id: 'ci:main' }],
      actor: { source: 'cnb', id: '' }, human: false, ...anyAt, text: 'CI passed 1/1 at abc1234\nRead cnb/branches/main/checks for every check.',
      url: `https://cnb.cool/${REPO}/-/commit/abc1234`, meta: { ci: true, branch: 'main', sha: 'abc1234', revision: 2 } })
    expect(branch.channel).toBeUndefined()
    const pr = ciTrigger({ number: '7', url: PAGE('7', true), prAuthor: 'alice' }, 3, 'CI failed 1/2 at abc1234: build\nRead cnb/pulls/7/checks for every check.')
    expect(pr).toEqual({ id: key('cnb-ci', '7', '3'), source: 'cnb', threads: [{ source: 'cnb', id: '7' }],
      actor: { source: 'cnb', id: '' }, human: false, ...anyAt, text: 'CI failed 1/2 at abc1234: build\nRead cnb/pulls/7/checks for every check.',
      channel: { source: 'cnb', thread: 'cnb:7', address: { number: '7', pr: '1', url: PAGE('7', true) } }, url: PAGE('7', true),
      meta: { number: '7', isPr: true, prAuthor: 'alice', ci: true, revision: 3 } })
  })

  it('parses PR/issue addresses and page URLs, and decides ended pulls', () => {
    expect(cnbAddress(`https://cnb.cool/${REPO}/-/pulls/12`, REPO)).toEqual({ number: '12', pr: true })
    expect(cnbAddress(`https://cnb.cool/${REPO}/-/pull/12#discussion`, REPO)).toEqual({ number: '12', pr: true })
    expect(cnbAddress(`https://cnb.cool/${REPO}/-/issues/3`, REPO)).toEqual({ number: '3', pr: false })
    expect(cnbAddress(`https://cnb.cool/other/org/-/issues/3`, REPO)).toBeUndefined()
    expect(cnbAddress(`https://github.com/${REPO}/issues/3`, REPO)).toBeUndefined()
    expect(cnbPage(REPO, '3')).toBe(PAGE('3', false))
    expect(cnbPage(REPO, '3', true)).toBe(PAGE('3', true))
    expect(pullEnded({ state: 'open', is_merged: null })).toBe(false)
    expect(pullEnded({ state: 'merged', is_merged: null })).toBe(true)
    expect(pullEnded({ state: 'closed', is_merged: false })).toBe(true)
    expect(pullEnded({ state: 'open', is_merged: true })).toBe(true)
  })

  it('formats the review place and its line span', () => {
    expect(reviewPlace(reviewComment())).toBe('src/a.ts:3-5\n+ const x = 1')
    expect(reviewPlace(reviewComment({ start_line: 4, end_line: 4 }))).toBe('src/a.ts:4\n+ const x = 1')
    expect(reviewPlace(reviewComment({ start_line: null, end_line: null, path: null }))).toBe('+ const x = 1')
  })
})

describe('cnb CI summaries', () => {
  it('counts checks by latest context and phrases failing, running, and passing summaries', () => {
    const commit = { sha: 'abc1234def5678', statuses: [
      { context: 'build', state: 'success' }, { context: 'build', state: 'failure' }, { context: 'lint', state: 'error' },
      { context: 'deploy', state: 'pending' }, { context: 'docs', state: 'skipped' }] }
    const counts = ciCounts(commit)
    expect(counts).toEqual({ counts: { failure: 1, error: 1, pending: 1, skipped: 1 }, failed: ['build', 'lint'],
      failedCount: 2, running: ['deploy'], head: 'abc1234' })
    expect(ciSummary(commit, 'cnb/pulls/7/checks')).toBe('CI failed 2/4 at abc1234: build; lint; still running: deploy\nRead cnb/pulls/7/checks for every check.')
    expect(ciSummary({ sha: 'abc1234def5678', statuses: [{ context: 'build', state: 'pending' }] }, 'r'))
      .toBe('CI running at abc1234: build\nRead r for every check.')
    expect(ciSummary(CI_OK, 'r')).toBe('CI passed 1/1 at abc1234\nRead r for every check.')
    expect(ciFact(commit)).toEqual({ label: { zh: 'CI', en: 'CI' }, value: { zh: '失败 2 项', en: 'failed 2' }, problem: true })
    expect(ciFact(CI_OK).value).toEqual({ zh: '通过', en: 'passed' })
  })

  it('reads commit statuses through the cnb CLI', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue(envelope(CI_OK))
    expect(await commitStatuses(commands, 'main')).toEqual(CI_OK)
    expect(run).toHaveBeenCalledWith('/bin/false', ['git', 'get-commit-statuses', '--repo', REPO, '--commitish', 'main', '-v'])
    expect(CommitStatusesSchema.safeParse({ statuses: null }).success).toBe(true)
  })
})

describe('cnb resource reader', () => {
  it('rejects unsupported paths without a request', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run')
    for (const resource of ['cnb/../outside', 'cnb/issues/0', 'cnb/issues/1/reviews', 'cnb/pulls/1/checks/2', 'cnb/issues/1/unknown']) {
      await expect(readCnb(commands, resource)).rejects.toThrow(/Use cnb\/issues|Checks do not take|Reviews, review threads and checks require/)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('reads an issue page, comment pages, and review pages with next references', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program: string, args: string[]) => {
      const key = `${args[0]} ${args[1]}`
      if (key === 'issues get-issue') return envelope({ number: '5', title: 'Broken thing', state: 'open',
        author: { username: 'alice', nickname: null, is_npc: false }, body: 'steps', created_at: '2026-09-01T00:00:00Z' })
      if (key === 'issues list-issue-comments' && args.includes('2')) return envelope(Array.from({ length: 20 }, (_, index) =>
        ({ id: `c${index}`, body: 'hi', author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-01T00:00:00Z' })))
      if (key === 'issues list-issue-comments') return envelope([{ id: 'c1', body: 'first', author: { username: 'alice', nickname: null, is_npc: false },
        created_at: '2026-09-01T00:00:00Z' }])
      if (key === 'pulls list-pull-reviews') return envelope([{ id: 'rv_1', body: 'looks good', review_state: 'approved',
        commit_hash: 'abc1234', author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-01T05:00:00Z' }])
      if (key === 'pulls list-pull-comments') return envelope([{ id: 'pc_1', body: 'reply', reply_to_comment_id: 'pc_0',
        author: { username: 'cnb-ai', nickname: null, is_npc: true }, created_at: '2026-09-01T06:00:00Z' }])
      throw new Error(`Unexpected: ${key}`)
    })
    expect(await readCnb(commands, 'cnb/issues/5')).toMatchObject({ number: '5', title: 'Broken thing', state: 'open',
      from: 'alice', text: 'Broken thing\n\nsteps' })
    expect(await readCnb(commands, 'cnb/issues/5/comments')).toMatchObject({ messages: [{ id: 'c1', text: 'first' }] })
    expect(await readCnb(commands, 'cnb/issues/5/comments/2')).toMatchObject({ next_resource: 'cnb/issues/5/comments/3',
      messages: Array.from({ length: 20 }, (_, index) => ({ id: `c${index}` })) })
    expect(await readCnb(commands, 'cnb/pulls/7/reviews')).toMatchObject({ messages: [{ id: 'rv_1', text: 'approved review of commit abc1234\n\nlooks good' }] })
    expect(await readCnb(commands, 'cnb/pulls/7/comments')).toMatchObject({ messages: [{ id: 'pc_1', text: 'reply', reply_to: 'pc_0', bot: true }] })
    expect(run).toHaveBeenCalledWith('/bin/false', ['pulls', 'list-pull-comments', '--repo', REPO, '--number', '7', '--page', '1', '--page-size', '20', '-v'])
  })

  it('reads PR checks and branch CI summaries, and errors without a review comment id', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program: string, args: string[]) => {
      const key = `${args[0]} ${args[1]}`
      if (key === 'pulls get-pull') return envelope({ ...openPull('7'), head: { ref: 'feature', sha: 'abc1234def5678', path: REPO } })
      if (key === 'pulls list-pull-commit-statuses') return envelope(statuses('abc1234def5678', [
        { context: 'build', state: 'failure' }, { context: 'test', state: 'pending' }]))
      if (key === 'git get-commit-statuses') return envelope(CI_OK)
      if (key === 'pulls list-pull-reviews') return envelope([])
      throw new Error(`Unexpected: ${key}`)
    })
    expect(await readCnb(commands, 'cnb/pulls/7/checks')).toMatchObject({ status: 'checks',
      summary: 'CI failed 1/2 at abc1234: build; still running: test\nRead cnb/pulls/7/checks for every check.', sha: 'abc1234def5678' })
    expect(await readCnb(commands, 'cnb/branches/main/checks')).toMatchObject({ status: 'branch_ci', sha: 'abc1234def5678',
      summary: 'CI passed 1/1 at abc1234\nRead cnb/branches/main/checks for every check.' })
    expect(await readCnb(commands, 'cnb/commits/abc1234def5678/checks')).toMatchObject({ status: 'branch_ci', sha: 'abc1234def5678',
      summary: 'CI passed 1/1 at abc1234\nRead cnb/commits/abc1234def5678/checks for every check.' })
    await expect(readCnb(commands, 'cnb/pulls/7/thread')).rejects.toThrow('Use cnb/issues/<number>')
    await expect(readCnb(commands, 'cnb/pulls/7/thread/missing')).rejects.toThrow('No review comment of this PR has that id')
  })

  it('rebuilds a review thread from its comments with the hunk on the root message', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    vi.spyOn(commands, 'run').mockImplementation(async (_program: string, args: string[]) => {
      const key = `${args[0]} ${args[1]}`
      if (key === 'pulls list-pull-reviews') return envelope([{ id: 'rv_1', body: '', review_state: 'commented', created_at: '2026-09-01T00:00:00Z' }])
      if (key === 'pulls list-pull-review-comments') return envelope([reviewComment({ id: 'rc_2', reply_to_comment_id: 'rc_1', body: 'done', created_at: '2026-09-01T02:00:00Z' }),
        reviewComment({ id: 'rc_1' }), reviewComment({ id: 'rc_other' })])
      throw new Error(`Unexpected: ${key}`)
    })
    const read = await cnbThreadContext.read(commands, { id: 't', source: 'cnb', threads: [], actor: { source: 'cnb', id: 'alice' }, human: true,
      at: '2026-09-01T00:00:00Z', text: '', meta: { number: '7', isPr: true, commentId: 'rc_1', kind: 'inline' } }, 'thread', undefined, undefined)
    expect(read.messages).toEqual([
      expect.objectContaining({ id: 'rc_1', from: 'alice', at: '2026-09-01T00:00:00Z', text: 'src/a.ts:3-5\n+ const x = 1\n\nplease fix' }),
      expect.objectContaining({ id: 'rc_2', text: 'done', reply_to: 'rc_1' })])
    await expect(cnbThreadContext.read(commands, { id: 't', source: 'cnb', threads: [], actor: { source: 'cnb', id: 'alice' }, human: true,
      at: '', text: '', meta: { number: '7', isPr: true, commentId: 'nope', kind: 'inline' } }, 'thread', undefined, undefined))
      .rejects.toThrow('No review comment of this PR has that id')
  })

  it('reads branch CI context straight from the trigger', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue(envelope(CI_OK))
    const read = await cnbThreadContext.read(commands, { id: 't', source: 'cnb', threads: [], actor: { source: 'cnb', id: '' }, human: false,
      at: '2026-09-01T00:00:00Z', text: 'CI passed 1/1 at abc1234\nRead cnb/branches/main/checks for every check.',
      url: 'https://cnb.cool/acme/widgets/-/commit/abc1234', meta: { ci: true, branch: 'main', sha: 'abc1234', revision: 1 } }, 'thread', undefined, undefined)
    expect(read.messages).toEqual([{ id: 'https://cnb.cool/acme/widgets/-/commit/abc1234', from: 'CI', at: '2026-09-01T00:00:00Z',
      text: 'CI passed 1/1 at abc1234\nRead cnb/commits/abc1234def5678/checks for every check.', bot: true }])
    expect(read.status).toBe('branch_ci')
    expect(run).toHaveBeenCalledWith('/bin/false', ['git', 'get-commit-statuses', '--repo', REPO, '--commitish', 'main', '-v'])
  })
})

describe('cnb replies', () => {
  it('posts a conversation comment and deduplicates its marker', async () => {
    const h = host()
    const channel = { source: 'cnb', thread: 'cnb:5', address: { number: '5', url: PAGE('5', false) } }
    const posted: unknown[] = []
    stubCnb(h, {
      'issues list-issue-comments': () => [{ id: 'old', body: 'unrelated', created_at: '2026-09-01T00:00:00Z' }, ...posted],
      'issues post-issue-comment': (args: string[]) => {
        posted.push({ id: `p${posted.length + 1}`, body: String(args.at(-2)), author: { username: 'agent-bot', nickname: null, is_npc: false },
          created_at: new Date().toISOString() })
        return []
      },
    })
    expect(await sendCnb(h, { id: 'm1', channel, text: 'working on it', kind: 'reply' })).toBe('sent')
    expect(h.commands.run).toHaveBeenCalledWith('/bin/false', ['issues', 'post-issue-comment', '--repo', REPO, '--number', '5',
      '--body', expect.stringContaining('working on it'), '-v'])
    const marker = expect.stringContaining('<!-- dsh-superagent:m1 -->')
    expect(await sendCnb(h, { id: 'm1', channel, text: 'working on it', kind: 'reply' })).toBe('sent')
    expect(vi.mocked(h.commands.run).mock.calls.filter(args => args[1].includes('post-issue-comment'))).toHaveLength(1)
    expect(marker).toBeTruthy()
    h.store.close()
  })

  it('replies inside a review thread only on a pull request, and reports gone conversations', async () => {
    const h = host()
    stubCnb(h, { 'pulls list-pull-comments': [], 'pulls list-pull-review-comments': [], 'pulls post-pull-request-review-reply': null })
    const review = { source: 'cnb', thread: 'cnb:7', address: { number: '7', pr: '1', review: 'rv_1', replyTo: 'rc_1', url: PAGE('7', true) } }
    expect(await sendCnb(h, { id: 'm2', channel: review, text: 'fixed', kind: 'reply' })).toBe('sent')
    expect(vi.mocked(h.commands.run).mock.calls.some(args => args[1].includes('post-pull-request-review-reply') &&
      args[1].includes('--review-id') && args[1].includes('--reply-to-comment-id'))).toBe(true)
    const issueReview = { source: 'cnb', thread: 'cnb:5', address: { number: '5', review: 'rv_1' } }
    await expect(sendCnb(h, { id: 'm3', channel: issueReview, text: 'fixed', kind: 'reply' })).rejects.toThrow('A cnb review reply requires a pull request')
    stubCnb(h, {})
    await expect(sendCnb(h, { id: 'm4', channel: { source: 'cnb', thread: 'cnb:9', address: {} }, text: 'hi', kind: 'reply' }))
      .rejects.toThrow('Missing cnb reply target')
    stubCnb(h, { 'issues list-issue-comments': [], 'issues post-issue-comment': () => { throw gone() } })
    expect(await sendCnb(h, { id: 'm5', channel: { source: 'cnb', thread: 'cnb:5', address: { number: '5' } }, text: 'hi', kind: 'reply' })).toBe('gone')
    stubCnb(h, { 'issues list-issue-comments': [], 'issues post-issue-comment': () => { throw refused(500, 'Server Error') } })
    await expect(sendCnb(h, { id: 'm6', channel: { source: 'cnb', thread: 'cnb:5', address: { number: '5' } }, text: 'hi', kind: 'reply' }))
      .rejects.toThrow('Server Error (HTTP 500)')
    h.store.close()
  })

  it('links a channel back to its cnb page', () => {
    expect(cnbLink({ number: '7', pr: '1' }, { cnb: { repository: REPO, cli: '/bin/true', login: 'agent-bot' } })).toEqual({ url: PAGE('7', true),
      label: { zh: 'cnb #7', en: 'cnb #7' } })
    expect(cnbLink({ number: '7', pr: '1', review: 'rv_1', url: 'https://example.com/r' }, {})
      .label).toEqual({ zh: 'cnb #7 的 review 讨论', en: 'Review discussion on cnb #7' })
    expect(cnbLink({ number: '7' }, {}).url).toBe('')
  })
})

describe('cnb pull claims', () => {
  it('binds an agent PR opened on the ticket branch and rejects foreign PRs', () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't1'))
    expect(claimPull(h, 't1', agentPullFixture('21', `agent/t1`))).toBeUndefined()
    expect(pullsOf(h.store.tickets.get('t1')!, true)).toEqual(['21'])
    expect(h.store.threads.get('cnb:21')).toMatchObject({ ref: { source: 'cnb', id: '21' },
      meta: { number: '21', isPr: true, url: PAGE('21', true), prAuthor: 'agent-bot' }, subscriptions: ['t1'] })
    h.store.tickets.save(ticket(h, 't2'))
    expect(claimPull(h, 't2', agentPullFixture('21', 'agent/t2'))).toContain('PR already belongs to another active ticket')
    expect(pullsOf(h.store.tickets.get('t2')!)).toEqual([])
    h.store.close()
  })

  it('binds the ticket\'s origin PR even from another author', () => {
    const h = host()
    const source = { id: key('cnb-issue', '30'), source: 'cnb', threads: [{ source: 'cnb', id: '30' }],
      actor: { source: 'cnb', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'please', meta: { number: '30', isPr: true, kind: 'pull' } }
    h.store.triggers.save(source)
    h.store.tickets.save(ticket(h, 't1', { origin: { triggerId: source.id, triggerIds: [source.id] } }))
    expect(claimPull(h, 't1', openPull('30'))).toBeUndefined()
    expect(pullsOf(h.store.tickets.get('t1')!, true)).toEqual(['30'])
    expect(claimPull(h, 't1', openPull('31'))).toContain('PR does not belong to this ticket')
    h.store.close()
  })

  it('ends a ticket when its followed PR merges and notifies its source channel once', async () => {
    const h = host()
    const request = { id: key('cnb-issue', '30'), source: 'cnb', threads: [{ source: 'cnb', id: '30' }],
      actor: { source: 'cnb', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: '@agent-bot 修一下标题', meta: { number: '30', isPr: true, kind: 'pull' } }
    h.store.triggers.save(request)
    h.store.tickets.save(ticket(h, 't1', { channels: [{ source: 'cnb', thread: 'cnb:30', address: { number: '30', pr: '1' } },
      { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }],
      origin: { triggerId: request.id, triggerIds: [request.id] } }))
    expect(claimPull(h, 't1', agentPullFixture('31', 'agent/t1'))).toBeUndefined()
    expect(await observePull(h, endedPull('31', '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    const notices = pullEndNotices(h.store.tickets.get('t1')!, request.text, REPO)
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: expect.objectContaining({ source: 'feishu' }) })])
    h.store.close()
  })

  it('rebinds a reopened PR and keeps another open PR working', async () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't5', { follows: [{ thread: 'cnb:21', own: true }, { thread: 'cnb:22', own: true,
      closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] }))
    expect(await observePull(h, agentPullFixture('22', 'agent/t5'))).toBe(false)
    expect(h.store.tickets.get('t5')!.follows).toEqual([{ thread: 'cnb:21', own: true }, { thread: 'cnb:22', own: true }])
    expect(await observePull(h, endedPull('22', '2026-09-03T00:00:00Z', false))).toBe(true)
    expect(h.store.tickets.get('t5')).toMatchObject({ follows: [{ thread: 'cnb:21', own: true },
      { thread: 'cnb:22', own: true, closed: { outcome: 'closed' } }] })
    expect(h.store.tickets.get('t5')!.ended).toBeUndefined()
    h.store.close()
  })

  it('writes the terminal notice in English for a request without Han characters', () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't2', { follows: [{ thread: 'cnb:12', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }],
      ended: { by: 'executor', outcome: 'closed', at: '2026-09-02T00:00:00.000Z' },
      channels: [{ source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }] }))
    expect(pullEndNotices(h.store.tickets.get('t2')!, 'fix the title', REPO))
      .toEqual([expect.objectContaining({ text: '[PR #12](https://cnb.cool/acme/widgets/-/pulls/12) was closed without merging.' })])
    expect(pullEndNotices(h.store.tickets.get('t2')!, '修一下标题', REPO))
      .toEqual([expect.objectContaining({ text: '[PR #12](https://cnb.cool/acme/widgets/-/pulls/12) 已关闭，未合并。' })])
    h.store.tickets.save(ticket(h, 't3', { follows: [{ thread: 'cnb:12', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] }))
    expect(pullEndNotices(h.store.tickets.get('t3')!, 'fix', REPO)).toEqual([])
    h.store.close()
  })
})

describe('cnb polling', () => {
  it('polls a subscribed PR thread: reads it lazily, skips the bot, and advances the cursor', async () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't1'))
    subscribed(h, '21', { number: '21', isPr: true, title: 'PR 21', url: PAGE('21', true) })
    const comments = [
      { id: 'c_old', body: 'before', author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-01T00:00:00Z' },
      { id: 'c_new', body: 'fresh', author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-02T00:00:00Z' },
      { id: 'c_bot', body: 'mine', author: { username: 'agent-bot', nickname: null, is_npc: false }, created_at: '2026-09-02T00:05:00Z' },
      { id: 'c_none', body: '', author: { username: 'alice', nickname: null, is_npc: false }, created_at: '2026-09-02T00:06:00Z' }]
    stubCnb(h, {
      'pulls get-pull': openPull('21'),
      'pulls list-pull-comments': comments,
      'issues list-issue-comments': [],
      'pulls list-pull-reviews': [],
    })
    // The cursor replaces the thread's real-wall-clock creation time; c_old sits before it and is skipped.
    h.state.set(KV.cnb.cursor('21'), '2026-09-01T12:00:00Z')
    await pollRound(h, new AbortController().signal)
    const received = h.receive.mock.calls.map(([trigger]) => trigger)
    expect(received.map(trigger => trigger.id)).toEqual([key('cnb-comment', 'cnb:21', 'c_new', '')])
    expect(received[0]).toEqual({ id: key('cnb-comment', 'cnb:21', 'c_new', ''), source: 'cnb', threads: [{ source: 'cnb', id: '21' }],
      actor: { source: 'cnb', id: 'alice' }, human: true, at: '2026-09-02T00:00:00Z', text: 'fresh',
      channel: { source: 'cnb', thread: 'cnb:21', address: { number: '21', pr: '1', url: PAGE('21', true) } }, url: PAGE('21', true),
      meta: { number: '21', isPr: true, prAuthor: 'alice', commentId: 'c_new', kind: 'conversation' } })
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.receive.mockClear()
    await pollRound(h, new AbortController().signal)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.threads.get('cnb:21')?.meta.pollError).toBeUndefined()
    h.store.close()
  })

  it('lazily identifies a subscribed thread and titles it from the PR read', async () => {
    const h = host()
    subscribed(h, '33')
    stubCnb(h, {
      'pulls get-pull': openPull('33'),
      'pulls list-pull-comments': [],
      'issues list-issue-comments': [],
      'pulls list-pull-reviews': [],
    })
    await pollRound(h, new AbortController().signal)
    expect(h.store.threads.get('cnb:33')).toMatchObject({ meta: { number: '33', isPr: true, url: PAGE('33', true) } })
    h.store.close()
  })

  it('falls back to an issue read for non-PR threads and reads issue comments', async () => {
    const h = host()
    subscribed(h, '5')
    stubCnb(h, {
      'pulls get-pull': () => { throw refused(404, 'Not Found') },
      'issues get-issue': { number: '5', title: 'Broken thing', state: 'open' },
      'issues list-issue-comments': [{ id: 'c9', body: 'a comment', author: { username: 'alice', nickname: null, is_npc: false },
        created_at: '2026-09-02T00:00:00Z' }],
    })
    h.state.set(KV.cnb.cursor('5'), '2026-09-01T00:00:00Z')
    await pollRound(h, new AbortController().signal)
    expect(h.store.threads.get('cnb:5')).toMatchObject({ meta: { number: '5', isPr: false, url: PAGE('5', false) } })
    expect(h.receive.mock.calls[0]?.[0]).toMatchObject({ id: key('cnb-comment', 'cnb:5', 'c9', ''), meta: { isPr: false, kind: 'conversation' } })
    h.store.close()
  })

  it('fires per-PR CI triggers from the second observed change onward, describing facts every round', async () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't1', { follows: [{ thread: 'cnb:21', own: true }] }))
    subscribed(h, '21', { number: '21', isPr: true, title: 'PR 21', url: PAGE('21', true) })
    const runs: Record<string, unknown>[] = [CI_OK, statuses('abc1234def5678', [{ context: 'build', state: 'failure' }]),
      statuses('abc1234def5678', [{ context: 'build', state: 'failure' }, { context: 'test', state: 'success' }])]
    let round = 0
    stubCnb(h, {
      'pulls get-pull': openPull('21'),
      'pulls list-pull-comments': [],
      'issues list-issue-comments': [],
      'pulls list-pull-reviews': [],
      'pulls list-pull-commit-statuses': () => runs[Math.min(round, runs.length - 1)],
    })
    h.receive.mockClear()
    await pollRound(h, new AbortController().signal)
    expect(h.receive).not.toHaveBeenCalled()
    expect((h.store.threads.get('cnb:21')?.meta as { facts?: Record<string, unknown> }).facts?.ci).toEqual({ label: { zh: 'CI', en: 'CI' }, value: { zh: '通过', en: 'passed' } })
    round = 1
    await pollRound(h, new AbortController().signal)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]?.[0]).toEqual({ id: key('cnb-ci', '21', '1'), source: 'cnb', threads: [{ source: 'cnb', id: '21' }],
      actor: { source: 'cnb', id: '' }, human: false, ...anyAt,
      text: 'CI failed 1/1 at abc1234: build\nRead cnb/pulls/21/checks for every check.',
      channel: { source: 'cnb', thread: 'cnb:21', address: { number: '21', pr: '1', url: PAGE('21', true) } }, url: PAGE('21', true),
      meta: { number: '21', isPr: true, prAuthor: 'alice', ci: true, revision: 1 } })
    expect((h.store.threads.get('cnb:21')?.meta as { facts?: Record<string, unknown> }).facts?.ci).toEqual({ label: { zh: 'CI', en: 'CI' }, value: { zh: '失败 1 项', en: 'failed 1' }, problem: true })
    round = 2
    h.receive.mockClear()
    await pollRound(h, new AbortController().signal)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]?.[0]).toEqual({ id: key('cnb-ci', '21', '2'), source: 'cnb', threads: [{ source: 'cnb', id: '21' }],
      actor: { source: 'cnb', id: '' }, human: false, ...anyAt,
      text: 'CI failed 1/2 at abc1234: build\nRead cnb/pulls/21/checks for every check.',
      channel: { source: 'cnb', thread: 'cnb:21', address: { number: '21', pr: '1', url: PAGE('21', true) } }, url: PAGE('21', true),
      meta: { number: '21', isPr: true, prAuthor: 'alice', ci: true, revision: 2 } })
    expect((h.store.threads.get('cnb:21')?.meta as { facts?: Record<string, unknown> }).facts?.ci).toEqual({ label: { zh: 'CI', en: 'CI' }, value: { zh: '失败 1 项', en: 'failed 1' }, problem: true })
    h.store.close()
  })

  it('fires branch CI only when a remembered failure set changes, and survives a branch rename', async () => {
    const h = host({}, { config: { observeCi: true } })
    const calls: string[][] = []
    stubCnb(h, {
      'git get-head': { name: 'main' },
      'git get-commit-statuses': () => statuses('abc1234def5678', [{ context: 'build', state: 'failure' }]),
    }, calls)
    h.receive.mockClear()
    await pollRound(h, new AbortController().signal)
    expect(h.receive).not.toHaveBeenCalled()
    await pollRound(h, new AbortController().signal)
    expect(h.receive).not.toHaveBeenCalled()
    vi.mocked(h.commands.run).mockImplementation(async (_program: string, args: string[]) => {
      calls.push(args)
      const key = `${args[0]} ${args[1]}`
      if (key === 'git get-head') return envelope({ name: 'release' })
      if (key === 'git get-commit-statuses') return envelope(statuses('abc1234def5678', [{ context: 'build', state: 'failure' }]))
      throw new Error(`Unexpected: ${key}`)
    })
    await pollRound(h, new AbortController().signal)
    expect(h.receive).not.toHaveBeenCalled()
    vi.mocked(h.commands.run).mockImplementation(async (_program: string, args: string[]) => {
      calls.push(args)
      const key = `${args[0]} ${args[1]}`
      if (key === 'git get-head') return envelope({ name: 'release' })
      if (key === 'git get-commit-statuses') return envelope(statuses('def5678', [{ context: 'build', state: 'success' }]))
      throw new Error(`Unexpected: ${key}`)
    })
    await pollRound(h, new AbortController().signal)
    expect(h.receive).toHaveBeenCalledTimes(1)
    const trigger = h.receive.mock.calls[0]?.[0] as Trigger
    expect(trigger.id).toBe(key('cnb-ci', 'branch:release', '1'))
    expect(trigger.threads).toEqual([{ source: 'cnb', id: 'ci:release' }])
    expect(trigger.channel).toBeUndefined()
    expect(trigger.text).toBe('CI passed 1/1 at def5678\nRead cnb/branches/release/checks for every check.')
    expect(h.store.threads.get('cnb:ci:release')).toMatchObject({ meta: { label: 'CI on release',
      facts: { ci: { label: { zh: 'CI', en: 'CI' }, value: { zh: '通过', en: 'passed' } } } } })
    h.store.close()
  })

  it('records per-thread poll errors and drops deleted threads from the round', async () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't1'))
    subscribed(h, '21', { number: '21', isPr: true, title: 'PR 21', url: PAGE('21', true) })
    stubCnb(h, { 'pulls get-pull': () => { throw gone() }, 'issues list-issue-comments': [] })
    await pollRound(h, new AbortController().signal)
    expect(h.board.all.cnb).toMatchObject({ state: 'ready', detail: expect.stringContaining('deleted on cnb.cool') })
    expect(h.store.threads.get('cnb:21')?.meta.pollError).toContain('410')
    h.store.close()
  })

  it('returns the polling interval as health and reports skipped items', async () => {
    const h = host()
    stubCnb(h, { 'git get-head': { name: 'main' }, 'git get-commit-statuses': CI_OK })
    const interval = await pollRound(h, new AbortController().signal)
    expect(interval).toBe(60)
    expect(h.board.all.cnb).toMatchObject({ state: 'ready', detail: 'next poll ≥ 60s', at: expect.any(String) })
    h.store.close()
  })

  it('reports error health only after the configured consecutive failures', () => {
    const error = new Error('socket hang up')
    expect(pollFailure(1, 3, error)).toBeUndefined()
    expect(pollFailure(3, 3, error)).toEqual({ state: 'error', code: 'pollFailures',
      detail: '3 consecutive failed polls; last: Error: socket hang up',
      values: { count: '3', error: 'Error: socket hang up' } })
  })
})

describe('cnb watch loop', () => {
  function start(overrides: Partial<SourceContextDeps> = {}, options: { enabled?: boolean; config?: Record<string, unknown> } = {}) {
    const disposers: (() => unknown)[] = []
    const h = host(overrides, { ...options, register: false })
    applyCnb({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    return { h, stop: async () => { for (const dispose of disposers) await dispose(); h.store.close() } }
  }

  it('pauses until the deployment is configured, then polls and reports failures', async () => {
    // Fake timers: the loop's between-round pause is a minute, and only the second consecutive failure may error.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { h, stop } = start({ configured: () => false })
      await vi.waitFor(() => expect(h.board.all.cnb).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await stop()

      const { h: running, stop: stopRunning } = start({}, { config: { repository: REPO, cli: '/bin/true' } })
      await vi.waitFor(() => expect(running.board.all.cnb).toMatchObject({ state: 'ready', detail: expect.stringContaining('next poll ≥ 60s') }))
      await stopRunning()

      const run = vi.spyOn(Commands.prototype, 'run').mockRejectedValue(new Error('socket hang up'))
      try {
        const { h: failing, stop: stopFailing } = start({}, { config: { repository: REPO, cli: '/bin/true', observeIssues: true, failuresBeforeError: 2 } })
        await vi.advanceTimersByTimeAsync(60_000) // second round
        await vi.waitFor(() => expect(failing.board.all.cnb).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
        await stopFailing()
      } finally { run.mockRestore() }
    } finally { vi.useRealTimers() }
  })

  it('reports an escaping setup failure as source health instead of crashing', async () => {
    const rejection = Promise.reject(new Error('lock held'))
    rejection.catch(() => {}) // The watch loop consumes this rejection; drop the unhandled-rejection noise.
    const { h, stop } = start({ ready: rejection })
    await vi.waitFor(() => expect(h.board.all.cnb).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    await stop()
  })
})

describe('cnb runCnb envelope handling', () => {
  it('parses the JSON envelope and fails closed on missing CLI, bad JSON, and API errors', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    await expect(runCnb(z.object({ name: z.string() }), commands, ['git', 'get-head'])).rejects.toThrow(CliError)
    vi.spyOn(commands, 'run').mockResolvedValue(envelope({ name: 'main' }))
    expect(await runCnb(z.object({ name: z.string() }), commands, ['git', 'get-head'])).toEqual({ name: 'main' })
    vi.spyOn(commands, 'run').mockResolvedValue('not json')
    await expect(runCnb(z.object({ name: z.string() }), commands, ['git', 'get-head'])).rejects.toThrow('cnb CLI returned no JSON envelope')
    vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ status: 404, message: 'nope' }))
    await expect(runCnb(z.object({ name: z.string() }), commands, ['git', 'get-head'])).rejects.toThrow('nope')
    const empty = new Commands(() => ({ ...testDeployment(), cnb: undefined }), {}, new AbortController().signal)
    await expect(runCnb(z.object({ name: z.string() }), empty, ['git', 'get-head'])).rejects.toThrow('The cnb.cool Source has no working CLI')
  })

  it('asks ticket PRs for their checks through the memoized pull read', async () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't1', { follows: [{ thread: 'cnb:21', own: true }] }))
    const run = vi.spyOn(h.commands, 'run').mockImplementation(async (_program: string, args: string[]) => {
      const key = `${args[0]} ${args[1]}`
      if (key === 'pulls get-pull') return envelope(openPull('21'))
      if (key === 'pulls list-pull-commit-statuses') return envelope(CI_OK)
      throw new Error(`Unexpected: ${key}`)
    })
    await pollTicketPulls(h)
    expect(run.mock.calls.filter(args => args[1].includes('get-pull'))).toHaveLength(1)
    expect(run.mock.calls.some(args => args[1].includes('list-pull-commit-statuses'))).toBe(true)
    await pollTicketPulls(h, undefined)
    expect(run.mock.calls.filter(args => args[1].includes('get-pull'))).toHaveLength(1)
    h.store.close()
  })

  it('leaves ended pulls alone and reports per-thread errors through pollThreads', async () => {
    const h = host()
    h.store.tickets.save(ticket(h, 't1', { follows: [{ thread: 'cnb:22', own: true }] }))
    const run = vi.spyOn(h.commands, 'run').mockImplementation(async (_program: string, args: string[]) => {
      const key = `${args[0]} ${args[1]}`
      if (key === 'pulls get-pull') return envelope(endedPull('22', '2026-09-02T00:00:00Z'))
      throw new Error(`Unexpected: ${key}`)
    })
    await pollTicketPulls(h)
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'cnb:22', own: true,
      closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } }], ended: { outcome: 'merged' } })
    expect(run.mock.calls.some(args => args[1].includes('list-pull-commit-statuses'))).toBe(false)

    const thread: Thread = { key: 'cnb:oops', ref: { source: 'cnb', id: 'oops' }, createdAt: new Date().toISOString(),
      subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
    h.store.threads.save(thread)
    await pollThreads(h, new AbortController().signal)
    expect(h.store.threads.get('cnb:oops')?.meta.pollError).toContain('no cnb issue or PR number')
    h.store.close()
  })
})
