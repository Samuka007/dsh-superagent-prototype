/** cnb.cool outbound channel: posts issue/PR comments and review thread replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { type CnbComment, CommentSchema, cnbPage } from './cnb-trigger.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { runCnb } from './cnb.ts'

/** True when cnb permanently refuses the conversation; cnb has no distinct deleted code, so only a gone-classified error counts. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 410 || (error.code === 404 && /已删除|deleted/i.test(error.message)))
/** Reads one full page (cnb caps `page_size` at 100) of comments, skipping items that fail the schema. */
async function comments(commands: Commands, pull: boolean, number: string, reviewId?: string): Promise<CnbComment[]> {
  const repository = commands.deployment.cnb?.repository ?? ''
  const found: CnbComment[] = []
  for (let page = 1;; page++) {
    const args = reviewId !== undefined
      ? ['pulls', 'list-pull-review-comments', '--repo', repository, '--number', number, '--review-id', reviewId, '--page', String(page), '--page-size', '100']
      : pull ? ['pulls', 'list-pull-comments', '--repo', repository, '--number', number, '--page', String(page), '--page-size', '100']
        : ['issues', 'list-issue-comments', '--repo', repository, '--number', number, '--page', String(page), '--page-size', '100']
    const listed = await runCnb(z.array(CommentSchema), commands, args)
    found.push(...listed)
    if (listed.length < 100) return found
  }
}
/**
 * Posts a conversation comment, or a review-thread reply when the address names a review, with an embedded HTML marker so
 * retries do not create duplicate comments; delivery is idempotent by message ID like the GitHub channel.
 */
export async function sendCnb(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const deployment = commands.deployment
  const number = message.channel.address.number ?? ''
  if (!/^[1-9]\d*$/.test(number)) throw new Error('Missing cnb reply target')
  const pull = message.channel.address.pr === '1'
  const review = message.channel.address.review
  const replyTo = message.channel.address.replyTo
  if (!pull && (review !== undefined || replyTo !== undefined)) throw new Error('A cnb review reply requires a pull request')
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const text = `${message.text}\n\n${marker}`
    const mine = (comment: CnbComment) => sameName(comment.author.username, deployment.cnb?.login ?? '')
      && (replyTo === undefined || comment.reply_to_comment_id === replyTo) && (comment.body ?? '').includes(marker)
    if ((await comments(commands, pull, number, pull ? review : undefined)).some(mine)) return 'sent'
    const body = ['--repo', deployment.cnb?.repository ?? '', '--number', number, '--body', text]
    if (review !== undefined) await runCnb(z.unknown(), commands,
      ['pulls', 'post-pull-request-review-reply', ...body, '--review-id', review, ...(replyTo !== undefined ? ['--reply-to-comment-id', replyTo] : [])])
    else if (pull) await runCnb(z.unknown(), commands, ['pulls', 'post-pull-comment', ...body])
    else await runCnb(z.unknown(), commands, ['issues', 'post-issue-comment', ...body])
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function cnbLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const review = address.review !== undefined
  const url = address.url ?? (links.cnb?.repository ? cnbPage(links.cnb.repository, number, address.pr === '1') : '')
  return { url, label: review ? { zh: `cnb #${number} 的 review 讨论`, en: `Review discussion on cnb #${number}` }
    : { zh: `cnb #${number}`, en: `cnb #${number}` } }
}
