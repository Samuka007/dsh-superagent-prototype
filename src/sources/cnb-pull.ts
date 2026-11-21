/** Pull request binding, lifecycle observation, and terminal IM notification helpers for cnb.cool. */
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { type CnbPull, cnbPage, pullEnded, PullSchema, SOURCE } from './cnb-trigger.ts'
import { runCnb } from './cnb.ts'

export type Pull = CnbPull & { number: string }
/** Reads one pull request through the cnb CLI; cnb numbers are strings shared with issues. */
export const readPull = async (ctx: SourceContext, number: string): Promise<Pull> =>
  ({ ...await runCnb(PullSchema, ctx.commands, ['pulls', 'get-pull', '--repo', ctx.deployment.cnb?.repository ?? '', '--number', number]), number })
const pullNumber = (thread: string): string | undefined => thread.startsWith(`${SOURCE}:`) ? thread.slice(SOURCE.length + 1) : undefined
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): string[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): string | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** True when the PR was opened by the agent account from a branch in the configured cnb repository (not a fork). */
export const agentPull = (pr: Pick<CnbPull, 'author' | 'head'>, deployment: Pick<Deployment, 'cnb'>): boolean =>
  !!deployment.cnb && sameName(pr.author?.username ?? '', deployment.cnb.login) && sameName(pr.head?.path ?? '', deployment.cnb.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head?.ref ?? '')
  if (!started && !opened) {
    const { login } = ctx.deployment.cnb ?? { login: '' }
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${pr.number}`)
  const open = pr.state === 'open'
  if (open && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pullEnded(pr)
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head?.ref ?? '')) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: pr.number }, own)
    ctx.threads.patch(`cnb:${pr.number}`, { number: pr.number, isPr: true, url: cnbPage(ctx.deployment.cnb?.repository ?? '', pr.number, true), prAuthor: pr.author?.username ?? 'unknown' })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return
  const outcome = pr.is_merged === true || pr.state === 'merged' ? 'merged' : 'closed'
  ctx.tickets.threadClosed({ source: SOURCE, id: pr.number }, outcome, pr.closed_at ?? pr.updated_at ?? new Date().toISOString())
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = pullNumber(follow.thread)!
  const url = cnbPage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // cnb timelines already show the merge or closure, so cnb channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
