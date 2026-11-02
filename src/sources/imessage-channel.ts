/** iMessage outbound channel: replies in a chat through `imsg-bridge`, idempotently by the outgoing message's id. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { imessageTriggerId, plainText } from './imessage-trigger.ts'

/**
 * The bridge command: `IMSG_BRIDGE_CLI` when set (an absolute path, as a launchd or tmux service has a short PATH), else
 * `imsg-bridge` on PATH. It is the same for the poll loop, replies and reads, which a Channel cannot take from configuration.
 */
export const bridgeCli = (): string => process.env.IMSG_BRIDGE_CLI || 'imsg-bridge'

/**
 * Sends a reply in the target chat. The bridge keeps a ledger of sent keys and, for a key it started but never confirmed,
 * looks for the agent's own message with the same text in that chat before sending again, so a retry after a crash does
 * not post twice. The bridge answers `{"error":{"code":410}}` when the chat no longer exists on the agent's account.
 */
export async function sendImessage(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing iMessage reply target')
  const text = plainText(checkedImText(message.text))
  try { await host.commands.run(bridgeCli(), ['reply', '--chat', chatId, '--key', message.id, '--text', text]) }
  catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
  return 'sent'
}
/** Messages has no web link to a chat, so the panel shows the chat's name and links the Trigger of the message instead. */
export const imessageLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => ({
  url: '', label: { zh: `iMessage 对话 ${address.chatId ?? ''}`, en: `iMessage chat ${address.chatId ?? ''}` },
  ...address.messageId ? { triggerId: imessageTriggerId(address.messageId) } : {},
})
