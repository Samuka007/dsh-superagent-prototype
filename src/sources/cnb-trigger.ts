/** Normalizes cnb.cool issues, pull requests, comments, reviews, and CI transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'cnb'
export const HOST = 'https://cnb.cool'
/**
 * Reply address of one cnb conversation: the Issue/PR number plus, for review threads, the review and parent comment IDs
 * the reply CLI requires; cnb comment URLs carry no usable anchor, so routing data travels in the address record itself.
 */
export const cnbChannel = (number: string, options: { pr?: boolean; review?: string; replyTo?: string; url?: string } = {}): ChannelRef =>
  ({ source: SOURCE, thread: `cnb:${number}`, address: { number,
    ...options.pr ? { pr: '1' } : {}, ...options.review ? { review: options.review } : {},
    ...options.replyTo ? { replyTo: options.replyTo } : {}, ...options.url ? { url: options.url } : {} } })
export const cnbPage = (repository: string, number: string, pr = false): string =>
  `${HOST}/${repository}/-/${pr ? 'pulls' : 'issues'}/${number}`
/**
 * Parses a cnb.cool Issue or PR page URL for its repository and number; returns undefined for other URLs, hosts, or
 * repositories. A queued reply may carry a stale repository name after a rename, which `sameName` accepts case-insensitively.
 */
export function cnbAddress(url: string, repository: string): { number: string; pr: boolean } | undefined {
  const address = /^https:\/\/cnb\.cool\/([^/]+\/[^/]+)\/-\/(issues|pulls?)\/([1-9]\d*)\/?(?:#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: match[3]!, pr: match[2]!.toLowerCase() !== 'issues' }
}
/** A cnb account; cnb reports deleted or missing authors inconsistently, so a missing author reads as a non-human `unknown`. */
export const UserSchema = z.looseObject({ username: z.string(), nickname: z.string().nullish(), is_npc: z.boolean().nullish() }).nullish()
  .transform(user => user ?? { username: 'unknown', nickname: null, is_npc: true })
export type CnbUser = z.infer<typeof UserSchema>
/** Renders a diff hunk's lines; cnb supplies each hunk as a list of diff lines rather than one text block. */
const renderHunk = (hunk: readonly CnbDiffLine[]): string =>
  hunk.map(line => (line.content ?? '').replace(/\n+$/, '')).filter(Boolean).join('\n')
/**
 * True when cnb reports the account as a person rather than a bot or NPC account.
 * Bots running under ordinary accounts still count as human here; the prompts identify which accounts are automated.
 */
export const isHumanUser = (user: CnbUser): boolean => user.is_npc !== true && !/^(cnb-?ai|dsh-?superagent)/i.test(user.username)
const author = (user: CnbUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && !sameName(user.username, agent) })
/**
 * One diff line of a review comment's hunk; `type` distinguishes context, addition, and deletion lines.
 */
export const DiffLineSchema = z.looseObject({
  content: z.string().nullish(), prefix: z.string().nullish(),
  left_line_number: z.number().nullish(), right_line_number: z.number().nullish(), type: z.string().nullish(),
})
export type CnbDiffLine = z.infer<typeof DiffLineSchema>
/**
 * A cnb comment or review: an Issue/PR conversation comment, an inline review comment (with its file, lines, diff hunk,
 * review, and parent comment ID), or a whole-PR review (with its `state` and optional summary body).
 */
export const CommentSchema = z.looseObject({
  id: z.string(), body: z.string().nullish(), author: UserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
  state: z.string().nullish(), commit_hash: z.string().nullish(), review_state: z.string().nullish(),
  path: z.string().nullish(), start_line: z.number().nullish(), end_line: z.number().nullish(),
  diff_hunk: z.array(DiffLineSchema).nullish(), reply_to_comment_id: z.string().nullish(), review_id: z.string().nullish(),
})
export type CnbComment = z.infer<typeof CommentSchema>
/** An Issue as cnb's API returns it; the list payload carries no description body, which triggers then read lazily if present. */
export const IssueSchema = z.looseObject({
  number: z.string(), title: z.string(), state: z.string().nullish(), author: UserSchema,
  body: z.string().nullish(), created_at: z.string().nullish(), updated_at: z.string().nullish(), last_acted_at: z.string().nullish(),
})
export type CnbIssue = z.infer<typeof IssueSchema>
/** A pull request as cnb's API returns it; `head`/`base` carry the branch refs and commit shas used for CI reads. */
export const PullSchema = z.looseObject({
  number: z.string(), title: z.string(), body: z.string().nullish(), state: z.string().nullish(), is_merged: z.boolean().nullish(),
  author: UserSchema, base: z.looseObject({ ref: z.string().nullish(), sha: z.string().nullish() }).nullish(),
  head: z.looseObject({ ref: z.string().nullish(), sha: z.string().nullish(), path: z.string().nullish() }).nullish(),
  closed_at: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), last_acted_at: z.string().nullish(),
})
export type CnbPull = z.infer<typeof PullSchema>
type Opened = { number: string; title: string; body?: string | null; author?: CnbUser; created_at?: string | null; updated_at?: string | null }
/** A cnb Issue/PR number with its page URL and, for pulls, the author used for agent-authored checks. */
export interface PullRef { number: string; isPr: boolean; url?: string; prAuthor?: string }
/** True when a PR has finished: cnb marks it `merged` or sets `is_merged`, and a closed-unmerged PR is finished too. */
export const pullEnded = (pull: Pick<CnbPull, 'state' | 'is_merged'>): boolean =>
  pull.state === 'merged' || pull.state === 'closed' || pull.is_merged === true
/** Formats an inline review comment's file and line range plus its rendered diff hunk. */
export function reviewPlace(comment: CnbComment): string {
  const span = comment.start_line != null && comment.end_line != null && comment.start_line !== comment.end_line
    ? `:${comment.start_line}-${comment.end_line}` : comment.start_line != null ? `:${comment.start_line}` : ''
  const hunk = renderHunk(comment.diff_hunk ?? [])
  return [`${comment.path ?? ''}${span}`, hunk].filter(part => part.trim()).join('\n')
}
function commentText(comment: CnbComment, kind: 'conversation' | 'inline' | 'review'): string {
  const state = comment.review_state ?? comment.state
  const decided = kind === 'review' && state && !['commented', 'pending'].includes(state)
  const decision = decided ? `${state} review of commit ${comment.commit_hash ?? 'unknown'}` : ''
  const body = comment.body ?? ''
  // A bodyless inline comment must stay empty (its place alone is not assessable), as the docstring below promises.
  const place = kind === 'inline' && comment.path && body.trim() ? reviewPlace(comment) : ''
  return [decision, place, body].filter(Boolean).join('\n\n')
}
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(username)}(?![a-zA-Z0-9_-])`, 'i').test(text)
/**
 * Builds a trigger for a comment, review, or review reply; text is empty for a bodyless comment or a `commented` review
 * without a body. The ID stays stable across re-reads of the same comment version so re-polls do not duplicate triggers.
 */
export function commentTrigger(comment: CnbComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.created_at ?? new Date().toISOString()
  const id = key('cnb-comment', `cnb:${ref.number}`, comment.id, comment.updated_at ?? '')
  const replyTo = comment.reply_to_comment_id ?? undefined
  const review = comment.review_id ?? (kind === 'review' ? comment.id : undefined)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: ref.number }], ...author(comment.author, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: cnbChannel(ref.number, { pr: ref.isPr, review: kind !== 'conversation' ? review : undefined,
      replyTo: replyTo ?? undefined, url: ref.url }),
    ...(ref.url ? { url: ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...(review && kind !== 'conversation' ? { reviewId: review } : {}),
      ...comment.path ? { path: comment.path, line: comment.start_line ?? null } : {},
      ...(replyTo ? { inReplyTo: replyTo } : {}) } }
}
/** Builds the trigger for a newly opened Issue's title and, when the API returned one, its description body. */
export function issueTrigger(issue: Opened, agent: string, url?: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('cnb-issue', issue.number), source: SOURCE,
    threads: [{ source: SOURCE, id: issue.number }], ...author(issue.author ?? { username: 'unknown', nickname: null, is_npc: true }, agent),
    at: issue.created_at ?? new Date().toISOString(),
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: cnbChannel(issue.number, { url }), ...(url ? { url } : {}),
    meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * Builds the trigger for a newly opened PR's title and description.
 * PR and Issue numbers share one sequence in cnb and never collide, so this reuses `issueTrigger`'s `cnb-issue` ID format.
 */
export function pullTrigger(pull: Opened, agent: string, url?: string): Trigger {
  return { ...issueTrigger(pull, agent, url),
    meta: { number: pull.number, isPr: true, prAuthor: pull.author?.username ?? 'unknown', kind: 'pull' } }
}
/** Builds a trigger for a default-branch CI transition; default-branch CI has no person to reply to, so it has no `channel`. */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('cnb-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: string; url?: string; prAuthor?: string }, revision: number, summary: string): Trigger {
  return { id: key('cnb-ci', pr.number, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: pr.number }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: cnbChannel(pr.number, { pr: true, url: pr.url }), ...(pr.url ? { url: pr.url } : {}),
    meta: { number: pr.number, isPr: true, prAuthor: pr.prAuthor ?? 'unknown', ci: true, revision } }
}
