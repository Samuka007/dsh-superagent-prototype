/** cnb.cool context reader: reconstructs conversation, review-thread, and CI context from the cnb CLI's JSON output. */
import { z } from 'zod'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { type CnbComment, CommentSchema, IssueSchema, PullSchema, reviewPlace } from './cnb-trigger.ts'
import { type Commands } from '../infra/commands.ts'
import { runCnb } from './cnb.ts'

/** CI states cnb may report on one commit; cnb has no `timed_out` or `startup_failure` vocabulary, and `skipped` does not fail a build. */
export const FAILING = new Set(['failure', 'error'])
/** Aggregates one commit's status list into counts, failing contexts, and running contexts, keeping each check context once. */
export function ciCounts(commit: {
  sha?: string | null
  state?: string | null
  statuses?: readonly { context?: string | null; state?: string | null; description?: string | null }[] | null
}): { counts: Record<string, number>; failed: string[]; failedCount: number; running: string[]; head: string } {
  const counts: Record<string, number> = {}
  const failed: string[] = []
  const running: string[] = []
  const latest = new Map<string, { state?: string | null; description?: string | null }>()
  for (const item of commit.statuses ?? []) {
    const context = item.context || 'unknown'
    latest.set(context, item)
  }
  for (const [context, item] of latest) {
    const state = item.state ?? ''
    counts[state] = (counts[state] ?? 0) + 1
    if (FAILING.has(state)) failed.push(context)
    if (state === 'pending') running.push(context)
  }
  return { counts, failed, failedCount: failed.length, running, head: (commit.sha ?? '').slice(0, 7) }
}
/** One-line CI summary for an assessment, phrased like the GitHub reader's. */
export function ciSummary(commit: Parameters<typeof ciCounts>[0], read: string): string {
  const { counts, failed, failedCount, running, head } = ciCounts(commit)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const passed = total - failedCount - running.length
  if (failedCount) {
    return `CI failed ${failedCount}/${total} at ${head}: ${failed.join('; ')}${running.length ? `; still running: ${running.join('; ')}` : ''}\nRead ${read} for every check.`
  }
  if (running.length) return `CI running at ${head}: ${running.join('; ')}\nRead ${read} for every check.`
  return `CI passed ${passed}/${total} at ${head}\nRead ${read} for every check.`
}
/** Bilingual thread fact for CI state: a problem when any status failed, running otherwise, passed when all succeeded. */
export function ciFact(commit: Parameters<typeof ciCounts>[0]): { label: { zh: string; en: string }; value: { zh: string; en: string }; problem?: true } {
  const { failedCount, running } = ciCounts(commit)
  if (failedCount) return { label: { zh: 'CI', en: 'CI' }, value: { zh: `失败 ${failedCount} 项`, en: `failed ${failedCount}` }, problem: true }
  if (running.length) return { label: { zh: 'CI', en: 'CI' }, value: { zh: '运行中', en: 'running' } }
  return { label: { zh: 'CI', en: 'CI' }, value: { zh: '通过', en: 'passed' } }
}
export const CommitStatusesSchema = z.looseObject({
  sha: z.string().nullish(), state: z.string().nullish(),
  statuses: z.array(z.looseObject({
    context: z.string().nullish(), state: z.string().nullish(), description: z.string().nullish(), target_url: z.string().nullish(),
  })).nullish(),
})
export type CnbCommitStatuses = z.infer<typeof CommitStatusesSchema>
/** Reads one commit's combined status; `commitish` accepts a branch name, commit hash, or tag. */
export function commitStatuses(commands: Commands, commitish: string): Promise<CnbCommitStatuses> {
  return runCnb(CommitStatusesSchema, commands, ['git', 'get-commit-statuses', '--repo', commands.deployment.cnb?.repository ?? '', '--commitish', commitish])
}
/** Marks bot accounts; cnb API payloads carry no comment URLs, so message `url` stays unset. */
function message(item: { author?: { username?: string | null; is_npc?: boolean | null } | null }, text: string, id: string, at: string): ContextMessage {
  const username = item.author?.username ?? ''
  const bot = item.author?.is_npc === true || /^(cnb-?ai|dsh-?superagent)/i.test(username)
  return { id, from: username || 'unknown', text, at, ...(bot ? { bot: true as const } : {}) }
}
/** One review thread: its root comment plus the replies reachable from it, sorted oldest first. */
function reviewThread(comments: CnbComment[], commentId: string): CnbComment[] {
  const root = comments.find(item => item.id === commentId)
  if (!root) return []
  const thread = [root]
  const inThread = new Set(thread.map(item => item.id))
  let grew = true
  while (grew) {
    grew = false
    for (const item of comments) {
      if (!inThread.has(item.id) && item.reply_to_comment_id && inThread.has(item.reply_to_comment_id)) {
        thread.push(item); inThread.add(item.id); grew = true
      }
    }
  }
  const at = (item: CnbComment) => item.created_at ?? ''
  return thread.sort((a, b) => at(a).localeCompare(at(b)))
}
/** Assembles review-thread messages; the root message carries its file:line and diff hunk as the GitHub reader does. */
function threadMessages(thread: CnbComment[]): ContextMessage[] {
  return thread.map((item, index) => {
    const text = index === 0 && item.path ? [reviewPlace(item), item.body ?? ''].filter(Boolean).join('\n\n') : item.body ?? ''
    return { ...message(item, text, item.id, item.created_at ?? ''), ...(index > 0 ? { reply_to: thread[index - 1]!.id } : {}) }
  })
}
/** Reads the review-thread comments reachable from one comment, resolving the owning review by listing the PR's reviews. */
async function reviewThreadOf(commands: Commands, number: string, commentId: string): Promise<CnbComment[]> {
  for (let page = 1;; page++) {
    const reviews = await runCnb(z.array(CommentSchema), commands,
      ['pulls', 'list-pull-reviews', '--repo', commands.deployment.cnb?.repository ?? '', '--number', number, '--page', String(page), '--page-size', '100'])
    for (const review of reviews) {
      const listed = await runCnb(z.array(CommentSchema), commands,
        ['pulls', 'list-pull-review-comments', '--repo', commands.deployment.cnb?.repository ?? '', '--number', number, '--review-id', review.id, '--page', '1', '--page-size', '100'])
      const thread = reviewThread(listed, commentId)
      if (thread.length) return thread
    }
    if (reviews.length < 100) return []
  }
}
/** One inline review comment of one review. */
async function reviewComments(commands: Commands, number: string, reviewId: string): Promise<CnbComment[]> {
  return runCnb(z.array(CommentSchema), commands,
    ['pulls', 'list-pull-review-comments', '--repo', commands.deployment.cnb?.repository ?? '', '--number', number, '--review-id', reviewId, '--page', '1', '--page-size', '100'])
}
/** Reads one page of an Issue or PR conversation (with the description first on page 1), using comment IDs as message IDs. */
async function conversationPage(commands: Commands, number: string, pull: boolean, page: number) {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const opened = await runCnb(pull ? PullSchema : IssueSchema, commands,
      [pull ? 'pulls' : 'issues', 'get-' + (pull ? 'pull' : 'issue'), '--repo', commands.deployment.cnb?.repository ?? '', '--number', number])
    messages.push(message(opened, `${opened.title}\n\n${opened.body ?? ''}`, String(opened.number), opened.created_at ?? ''))
  }
  const args = pull
    ? ['pulls', 'list-pull-comments', '--repo', commands.deployment.cnb?.repository ?? '', '--number', number, '--page', String(page), '--page-size', '100']
    : ['issues', 'list-issue-comments', '--repo', commands.deployment.cnb?.repository ?? '', '--number', number, '--page', String(page), '--page-size', '100']
  const listed = await runCnb(z.array(CommentSchema), commands, args)
  messages.push(...listed.map(comment => message(comment, comment.body ?? '', comment.id, comment.created_at ?? '')))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null }
}
/**
 * Context reader for a cnb Trigger: reads the review thread for an inline review comment (whose first comment is its root
 * and parent), the default branch's CI summary (whose Trigger is its context), or the Issue/PR conversation by page
 * otherwise (whose first page is its root and parent).
 */
export const cnbThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    // The default branch's CI has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === 'string') {
      const statuses = await commitStatuses(commands, trigger.meta.branch)
      const sha = statuses.sha ?? ''
      const summary = ciSummary({ ...statuses, sha }, `cnb/commits/${sha}/checks`)
      const message: ContextMessage = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: summary, bot: true }
      return { messages: [message], body: { status: 'branch_ci', messages: [message] }, status: 'branch_ci' }
    }
    const number = String(trigger.meta.number)
    const pull = trigger.meta.isPr === true
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.commentId === 'string') {
      const reviewId = typeof trigger.meta.reviewId === 'string' ? trigger.meta.reviewId : undefined
      const thread = reviewId !== undefined
        ? reviewThread(await reviewComments(commands, number, reviewId), trigger.meta.commentId)
        : await reviewThreadOf(commands, number, trigger.meta.commentId)
      if (!thread.length) throw new Error('No review comment of this PR has that id')
      const messages = threadMessages(thread)
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'review_thread', messages: read }, status: 'review_thread' }
    }
    const body = await conversationPage(commands, number, pull, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
/**
 * Reads a cnb resource for assessment and tooling: one Issue/PR description page, comment/review pages, one PR's CI, or
 * the default branch's CI. Resources mirror the GitHub reader: `cnb/issues/<number>[...sections]`.
 */
export async function readCnb(commands: Commands, resource: string): Promise<unknown> {
  const repository = commands.deployment.cnb?.repository ?? ''
  // The default branch's CI, which no PR names.
  const branch = /^cnb\/branches\/([^/]+)\/checks$/.exec(resource)
  if (branch) {
    const statuses = await commitStatuses(commands, decodeURIComponent(branch[1]!))
    return { status: 'branch_ci', summary: ciSummary({ ...statuses, sha: statuses.sha ?? '' }, resource), ...statuses }
  }
  const commit = /^cnb\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource)
  if (commit) {
    const statuses = await commitStatuses(commands, commit[1]!)
    return { status: 'branch_ci', ...statuses, summary: ciSummary(statuses, resource) }
  }
  const match = /^cnb\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*|[\w-]+))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use cnb/issues/<number>, cnb/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or cnb/branches/<name>/checks')
  }
  const kind = match[1]!
  const number = match[2]!
  const section = match[3]
  const page = match[4] ?? '1'
  const pull = kind === 'pulls'
  if (!pull && (section === 'reviews' || section === 'checks' || section === 'thread')) {
    throw new Error('Reviews, review threads and checks require a pull request')
  }
  const repo = ['--repo', repository, '--number', number]
  if (section === 'checks') {
    if (page !== '1') throw new Error('Checks do not take a page number')
    const opened = await runCnb(PullSchema, commands, ['pulls', 'get-pull', ...repo])
    const statuses = await runCnb(CommitStatusesSchema, commands, ['pulls', 'list-pull-commit-statuses', '--repo', repository, '--number', number])
    const statusesSha = statuses.sha ?? opened.head?.sha ?? ''
    return { status: 'checks', summary: ciSummary({ ...statuses, sha: statusesSha }, resource), ...statuses, sha: statusesSha }
  }
  if (section === 'thread') {
    if (match[4] === undefined) throw new Error('Use cnb/issues/<number>, or name the review thread by one of its comments: cnb/pulls/<number>/thread/<comment-id>')
    const thread = await reviewThreadOf(commands, number, page)
    if (!thread.length) throw new Error('No review comment of this PR has that id')
    return { messages: threadMessages(thread) }
  }
  if (!section) {
    const opened = await runCnb(pull ? PullSchema : IssueSchema, commands, [pull ? 'pulls' : 'issues', pull ? 'get-pull' : 'get-issue', ...repo])
    const raw = opened as Record<string, unknown>
    const labels = Array.isArray(raw.labels)
      ? { labels: raw.labels.map(label => (label as { name?: string | null } | null)?.name).filter(Boolean) } : {}
    const pr = pull ? (opened as z.infer<typeof PullSchema>) : undefined
    return { number: opened.number, title: opened.title, state: opened.state ?? '', ...opened.is_merged ? { merged: true } : {},
      ...pr?.head?.ref && pr.base?.ref ? { head: pr.head.ref, base: pr.base.ref } : {}, ...labels,
      ...message(opened, `${opened.title}\n\n${opened.body ?? ''}`, String(opened.number), opened.created_at ?? '') }
  }
  const listed = section === 'reviews'
    ? await runCnb(z.array(CommentSchema), commands, ['pulls', 'list-pull-reviews', ...repo, '--page', page, '--page-size', '20'])
    : await runCnb(z.array(CommentSchema), commands, pull ? ['pulls', 'list-pull-comments', ...repo, '--page', page, '--page-size', '20'] : ['issues', 'list-issue-comments', ...repo, '--page', page, '--page-size', '20'])
  const messages = listed.map(item => section === 'reviews'
    ? { ...message(item, item.review_state && !['commented', 'pending'].includes(item.review_state)
      ? `${item.review_state} review of commit ${item.commit_hash ?? 'unknown'}${item.body ? `\n\n${item.body}` : ''}` : item.body ?? '', item.id, item.created_at ?? '') }
    : { ...message(item, item.body ?? '', item.id, item.created_at ?? ''), ...item.reply_to_comment_id ? { reply_to: item.reply_to_comment_id } : {} })
  return { messages, ...listed.length === 20 ? { next_resource: `cnb/${kind}/${number}/${section}/${Number(page) + 1}` } : {} }
}
