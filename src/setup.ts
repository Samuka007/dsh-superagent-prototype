/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'github' | 'feishu' | 'cnb'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  cnbCliFailed: ['cnb', 'The cnb CLI does not work.'],
  cnbCliMissing: ['cnb', 'The cnb CLI of the cnb.cool Source was not found.'],
  cnbCliSignedOut: ['cnb', 'The cnb CLI cannot read its account.'],
  cnbNoAccount: ['cnb', 'The cnb CLI did not report a cnb.cool account.'],
  cnbRepositoryUnreadable: ['cnb', '@{account} cannot read {repository}.'],
  cnbRepositoryUnreported: ['cnb', 'The cnb CLI did not return {repository}.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
