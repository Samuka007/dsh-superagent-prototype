/** cnb.cool source kind definition, repository and thread polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { CnbAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { ciCounts, ciFact, ciSummary, CommitStatusesSchema, cnbThreadContext, commitStatuses } from './cnb-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, cnbPage, HOST, type CnbIssue, type CnbPull, IssueSchema, issueTrigger,
  pullEnded, pullTrigger, PullSchema, type PullRef, SOURCE } from './cnb-trigger.ts'
import { cnbLink, sendCnb } from './cnb-channel.ts'
import { observePull, pullsOf, readPull, type Pull } from './cnb-pull.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

export { commentTrigger, type CnbComment } from './cnb-trigger.ts'

const CnbConfigSchema = CnbAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false),
  observeComments: z.boolean().default(false), observeCi: z.boolean().default(false),
}).strict()
export type CnbConfig = z.infer<typeof CnbConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
/**
 * Runs the agent's cnb CLI with `-v`, parses the JSON envelope's `data` payload, and validates it against `schema`.
 * cnb exits 3 for an HTTP error with the status JSON on stdout and 1 for a CLI or auth failure with Chinese stderr.
 * @throws CliError carrying cnb's HTTP status as `code` on failure.
 */
export async function runCnb<T>(schema: z.ZodType<T>, commands: Commands, args: string[]): Promise<T> {
  const cnb = commands.deployment.cnb
  if (!cnb) throw new Error('The cnb.cool Source has no working CLI')
  const output = await commands.run(cnb.cli, [...args, '-v'])
  let envelope: { status?: number; data?: unknown; message?: string }
  try { envelope = JSON.parse(output) as typeof envelope } catch { throw new CliError('cnb CLI returned no JSON envelope') }
  if (typeof envelope.status === 'number' && envelope.status >= 400) {
    throw new CliError(envelope.message ?? `cnb API error ${envelope.status}`, envelope.status)
  }
  return schema.parse(envelope.data)
}
export const cnbKind: SourceKind<CnbConfig> = {
  kind: SOURCE,
  title: { zh: 'cnb.cool', en: 'cnb.cool' },
  description: {
    zh: '智能体的 cnb.cool 账号；接收仓库里的新 Issue 与 PR、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。',
    en: 'The agent\'s cnb.cool account; receives new Issues and pull requests in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.',
  },
  schema: CnbConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。这个来源通过 cnb CLI 接收这个仓库的讨论和 CI；保存时检查 CLI 能读到它，然后重启 dsh-superagent。', en: 'Written owner/name. This Source reads the repository\'s discussion and CI through the cnb CLI; saving checks that the CLI can read it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 cnb CLI', en: 'Agent cnb CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 CNB_TOKEN 登录智能体账号的 cnb 包装脚本。智能体以它登录的账号行事，执行器以 cnb 调用它。保存时检查它的账号能否读到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a cnb wrapper signed in to the agent account through CNB_TOKEN. The agent acts as the account it is signed in to, and the Executor calls it as cnb. Saving checks that this account can read the repository, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'cnb 没有事件推送，来源按这个间隔轮询；间隔越短，对 API 的请求越多。', en: 'cnb has no event push, so the Source polls at this interval; a shorter interval sends more API requests.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['cnb'],
  channel: { send: sendCnb, link: cnbLink },
  threadContext: cnbThreadContext,
  // `#12`, `12`, or the page of an Issue or PR of the watched repository names Thread 12.
  find: query => {
    const number = (/^#?([1-9]\d*)$/.exec(query.trim()) ?? /cnb\.cool\/[^/]+\/[^/]+\/-\/(?:pulls?|issues)\/([1-9]\d*)/i.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 cnb.cool 账号', en: 'cnb.cool accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repository on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = CnbConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CNB_REPOSITORY', description: { zh: '这个来源监听的 cnb.cool 仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The cnb.cool repository this Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_CNB_ACCOUNT', description: { zh: '智能体的 cnb.cool 账号；cnb CLI 以它登录，cnb.cool 的操作都用 cnb，不用其他账号或凭据', en: 'The agent\'s cnb.cool account. The cnb CLI is signed in to it; use cnb for every cnb.cool operation, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_CNB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 cnb.cool 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on cnb.cool' } },
    ],
    values: ({ deployment, trigger }) => {
      const meta = trigger?.threads[0]?.source === SOURCE ? trigger.meta : undefined
      const number = Number(meta?.number) || 0
      return { DSH_SUPERAGENT_CNB_REPOSITORY: deployment.cnb?.repository ?? '', DSH_SUPERAGENT_CNB_ACCOUNT: deployment.cnb?.login ?? '',
        DSH_SUPERAGENT_CNB_NUMBER: number ? String(number) : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.cnb ? {
    cli: { zh: `当前账号 @${deployment.cnb.login}`, en: `Current account @${deployment.cnb.login}` },
  } : {},
}
export const name = 'dsh-superagent-cnb'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(cnbKind), 'cnb: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, cnbKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('cnb', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('cnb', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<CnbConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('cnb', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('cnb', failed)
    }
    await pause(Math.max(interval, ctx.config<CnbConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Map<string, Promise<Pull>>; read: Set<string>; failures: string[]; dropped: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], dropped: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
export interface CnbRetry { since: string; pr: boolean; failedAt?: string; attempts?: number }
/** True when cnb returns HTTP 410 (Gone); other failures are retried because they may be transient. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** Records a failed read on the Thread and in the round; deleted (410) threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, number: string, error: unknown): void {
  if (deleted(error)) round.dropped.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(`cnb:${number}`, { pollError: String(error) })
}
/** Repository-wide event streams; cnb has no notifications API, so these streams and the subscribed threads carry everything. */
const STREAMS = [
  { id: 'issues', observed: (config: CnbConfig) => config.observeIssues,
    args: (repository: string) => ['issues', 'list-issues', '--repo', repository, '--order-by', '-updated_at'] },
  { id: 'pulls', observed: (config: CnbConfig) => config.observePulls,
    args: (repository: string) => ['pulls', 'list-pulls', '--repo', repository, '--order-by', '-updated_at'] },
] as const
/**
 * Polls repository-wide streams (new Issues/PRs, default-branch CI); each stream reads from when it was switched on, resets
 * when switched off, and fails independently. cnb has no notifications API, so these streams and the subscribed Threads carry everything.
 */
async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<CnbConfig>(SOURCE)
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.cnb.stream(stream.id), undefined); continue }
    try { await readStream(ctx, round, stream) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.cnb.branchCi)
    ctx.state.set(KV.cnb.branchCi, seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}
/** Timestamp used for stream ordering and cursors; cnb lists sort by `updated_at`, falling back to `created_at`. */
const stamp = (item: unknown): number => {
  const read = (typeof item === 'object' && item ? item : {}) as { updated_at?: string | null; created_at?: string | null }
  return Date.parse(read.updated_at ?? read.created_at ?? '')
}
/**
 * Reads one repository-wide event stream since its cursor and steps the cursor to five seconds before the newest item
 * (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. cnb sorts newest first and has no
 * `since` filter, so pages are read back until one predates the cursor and sorted oldest first; only newly opened
 * Issues/PRs become Triggers, and items from before the stream was switched on or beyond the horizon are ignored.
 */
async function readStream(ctx: SourceContext, round: Round, stream: typeof STREAMS[number]): Promise<void> {
  const name = KV.cnb.stream(stream.id)
  const stored = ctx.state.get(name)
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = { [stream.id]: before[stream.id] ?? round.started }
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const repository = ctx.deployment.cnb?.repository ?? ''
  const fresh = (item: { created_at?: string | null }): boolean =>
    Date.parse(item.created_at ?? '') >= Math.max(Date.parse(started[stream.id] ?? round.started), horizon)
  const listed: unknown[] = []
  const commands = ctx.commands.withSignal(round.signal)
  for (let page = 1; ; page += 1) {
    if (stopped(ctx, round)) throw new Error('The cnb Source stopped during the poll')
    const items = await runCnb(z.array(z.unknown()), commands, [...stream.args(repository), '--page', String(page), '--page-size', '100'])
    listed.push(...items)
    // cnb sorts newest first and has no `since` filter: stop once a whole page predates the cursor.
    if (items.length < 100 || !items.some(item => stamp(item) >= Date.parse(since))) break
  }
  const items = [...validItems(stream.id === 'pulls' ? PullSchema : IssueSchema, listed, round.tally)].sort((a, b) => stamp(a) - stamp(b))
  const { login } = ctx.deployment.cnb ?? { login: '' }
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error('The cnb Source stopped during the poll')
    if (sameName(item.author.username, login)) continue
    if (!fresh(item)) continue
    const isPr = stream.id === 'pulls'
    const url = cnbPage(repository, item.number, isPr)
    await ctx.receive(isPr ? pullTrigger(item, login, url) : issueTrigger(item, login, url))
    nameThread(ctx, item.number, item.title)
  }
  const stamps = items.map(item => stamp(item)).filter(value => Number.isFinite(value))
  const newest = stamps.length ? Math.max(...stamps) : Number.NaN
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  ctx.state.set(name, { since: next, started })
}
/** Polls the default branch's CI; the first observation only establishes the baseline, and later changes in the failing set become Triggers. */
async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const repository = ctx.deployment.cnb?.repository ?? ''
  // `git get-head` returns the branch name only; its statuses read carries the commit hash used for trigger URLs.
  const branch = (await runCnb(z.looseObject({ name: z.string() }), commands, ['git', 'get-head', '--repo', repository])).name
  const snapshot = await commitStatuses(commands, branch)
  const full = { ...snapshot, sha: snapshot.sha ?? '' }
  const previous = ctx.state.get(KV.cnb.branchCi)
  const known = previous?.branch === branch ? previous.failures : undefined
  const counts = ciCounts(full)
  // Retain previous failures while checks are still running so a partially-failing build does not clear the alarm early.
  const now = counts.failed.length || !counts.running.length ? counts.failed : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(full, `cnb/branches/${encodeURIComponent(branch)}/checks`)
    await ctx.receive(branchCiTrigger(branch, full.sha, revision, summary, `${HOST}/${repository}/-/commit/${full.sha}`))
    ctx.threads.describe(`cnb:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(full) } })
  }
  ctx.state.set(KV.cnb.branchCi, { branch, failures: now, revision })
}
/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, number: string): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}
/**
 * The round-less ticket-poll entry point shares one implicit round per context, so repeated calls within a polling round
 * reuse memoized pull reads instead of re-reading them.
 */
const implicitRounds = new WeakMap<SourceContext, Round>()
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round?: Round): Promise<void> {
  let active = round
  if (!active) {
    active = implicitRounds.get(ctx)
    if (!active) {
      active = newRound(signal)
      implicitRounds.set(ctx, active)
    }
  }
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
  for (const number of numbers) {
    if (stopped(ctx, active)) return
    try {
      const pr = await pull(ctx, active, number)
      if (!pullEnded(pr)) await pollChecks(ctx, active, number, pr)
    } catch (error) { if (!stopped(ctx, active)) failed(ctx, active, number, error) }
  }
}
/** Polls a PR's CI checks; only changes after the first baseline observation become Triggers. */
async function pollChecks(ctx: SourceContext, round: Round, number: string, pr: Pull): Promise<void> {
  const repository = ctx.deployment.cnb?.repository ?? ''
  const statuses = await runCnb(CommitStatusesSchema, ctx.commands.withSignal(round.signal),
    ['pulls', 'list-pull-commit-statuses', '--repo', repository, '--number', number])
  const snapshot = { ...statuses, sha: statuses.sha ?? pr.head?.sha ?? '' }
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.cnb.ci(number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) {
    await ctx.receive(ciTrigger({ number, url: cnbPage(repository, number, true), prAuthor: pr.author.username },
      revision, ciSummary(snapshot, `cnb/pulls/${number}/checks`)))
  }
  ctx.state.set(KV.cnb.ci(number), { fingerprint, revision })
  ctx.threads.describe(`cnb:${number}`, { facts: { ci: ciFact(snapshot) } })
}
function nameThread(ctx: SourceContext, number: string, title: string): void {
  ctx.threads.patch(`cnb:${number}`, { title })
  ctx.threads.describe(`cnb:${number}`, { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(thread.ref.id); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.ref.id))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const number = thread.ref.id
  if (!/^\d+$/.test(number)) throw new Error('Subscribed thread has no cnb issue or PR number')
  round.read.add(number)
  const repository = ctx.deployment.cnb?.repository ?? ''
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    // cnb numbers Issues and PRs from one sequence, so a PR read identifies the kind and the Issue read is the fallback.
    let isPr = false
    let title = ''
    try {
      const pr = await runCnb(PullSchema, ctx.commands.withSignal(round.signal), ['pulls', 'get-pull', '--repo', repository, '--number', number])
      isPr = true; title = pr.title
    } catch { /* not a PR: read the number as an Issue instead */ 
      const issue = await runCnb(IssueSchema, ctx.commands.withSignal(round.signal), ['issues', 'get-issue', '--repo', repository, '--number', number])
      title = issue.title
    }
    ctx.threads.patch(thread.key, { number, isPr, url: cnbPage(repository, number, isPr) })
    if (title) nameThread(ctx, number, title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.cnb.cursor(number)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: cnbPage(repository, number, true), prAuthor: pr.author.username }, since, round)
  } else await intakeComments(ctx, { number, isPr: false }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
/**
 * Reads a thread's Issue conversation and, for PRs, its review threads since the cursor. cnb has no server-side `since`
 * filter, so every listing is read back and filtered client-side; a review decision without a body still becomes a
 * Trigger because a worker may be waiting for that approval.
 */
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const repository = ctx.deployment.cnb?.repository ?? ''
  const { login } = ctx.deployment.cnb ?? { login: '' }
  const read = async (args: string[]): Promise<unknown[]> => {
    const listed: unknown[] = []
    for (let page = 1; ; page += 1) {
      if (stopped(ctx, round)) throw new Error('The cnb Source stopped during the poll')
      const items = await runCnb(z.array(z.unknown()), commands, [...args, '--page', String(page), '--page-size', '100'])
      listed.push(...items)
      if (items.length < 100) return listed
    }
  }
  const batches: { kind: 'conversation' | 'inline' | 'review'; comments: unknown[] }[] = [
    { kind: 'conversation', comments: await read(['issues', 'list-issue-comments', '--repo', repository, '--number', ref.number]) },
  ]
  if (ref.isPr) {
    batches.push({ kind: 'conversation', comments: await read(['pulls', 'list-pull-comments', '--repo', repository, '--number', ref.number]) })
    const reviews = await read(['pulls', 'list-pull-reviews', '--repo', repository, '--number', ref.number])
    batches.push({ kind: 'review', comments: reviews })
    // Each review's inline comments live in their own listing keyed by the review ID.
    for (const review of reviews) {
      const parsed = z.looseObject({ id: z.string() }).safeParse(review)
      if (parsed.success) batches.push({ kind: 'inline',
        comments: await read(['pulls', 'list-pull-review-comments', '--repo', repository, '--number', ref.number, '--review-id', parsed.data.id]) })
    }
  }
  for (const batch of batches) {
    for (const comment of validItems(CommentSchema, batch.comments, round.tally)) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The cnb Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.author.username, login)) continue
      const trigger = commentTrigger(comment, ref, batch.kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
/** One full polling round: repository streams, ticket PRs with their CI, and subscribed Threads; returns the seconds until the next round. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  const interval = ctx.config<CnbConfig>(SOURCE)?.pollSeconds ?? 60
  if (signal?.aborted) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} cnb reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (numbers: string[]) => [...new Set(numbers)].sort((a, b) => Number(a) - Number(b)).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on cnb.cool: ${named(round.dropped)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('cnb', { state: 'ready', detail: `next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}
