/**
 * Renders the request a session title is generated from. OpenCode calls
 * `render` on the `title` hook's `history`; a plugin that wants a different
 * request composes these pieces itself and assigns `messages`.
 */
import type { SessionMessage } from "@opencode/schema/session-message"
import type { SessionTitle } from "./promise/session.js"

export type History = ReadonlyArray<SessionMessage.Info>
export type Reason = SessionTitle["reason"]

/** Character budget of a regenerated title request, framing included; an initial request carries the whole first message. */
export const BUDGET = 8_000
const MAX_ORIGINAL_LENGTH = 2_000

// Framing the input as text to name keeps models from answering or carrying out the request instead.
const messagePrompt = (text: string) =>
  `Here is the first message of the conversation:\n\n<message>\n${text}\n</message>\n\nReply with only the title.`
const conversationPrompt = (text: string) =>
  `Here is the conversation so far:\n\n<conversation>\n${text}\n</conversation>\n\nReply with only the title.`

/** The first user message in `history`, which anchors the topic. */
export const original = (history: History) => history.find((message) => message.type === "user")?.text ?? ""

/** Every message in `history` but the first user message: user text and the assistant's text parts, in `history` order. */
export const turns = (history: History) => {
  const first = history.find((message) => message.type === "user")
  return history.flatMap((message): Array<{ role: "user" | "assistant"; text: string }> => {
    if (message.type === "user") return message === first ? [] : [{ role: "user", text: message.text.trim() }]
    if (message.type !== "assistant") return []
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n")
    return text ? [{ role: "assistant", text }] : []
  })
}

/**
 * The text the title model reads, or `""` when `history` has no user message to
 * anchor a title. An `initial` title is generated from the whole first user
 * message, framed as a message to name. A `regenerate` one (the default) labels
 * the first message, clipped to 2,000 characters, fills the rest of `BUDGET`
 * with the end of the turns, and frames the result as a conversation to name.
 */
export function render(history: History, reason: Reason = "regenerate"): string {
  if (!history.some((message) => message.type === "user")) return ""
  const first = original(history)
  if (reason === "initial") return messagePrompt(first)
  const labelled = `Original request:\n${first.slice(0, MAX_ORIGINAL_LENGTH)}`
  const recent = turns(history)
    .map((turn) => (turn.role === "user" ? `User: ${turn.text}` : `Assistant: ${turn.text}`))
    .join("\n\n")
  if (!recent) return conversationPrompt(labelled)
  const prefix = `${labelled}\n\nRecent conversation:\n`
  return conversationPrompt(`${prefix}${recent.slice(-(BUDGET - conversationPrompt("").length - prefix.length))}`)
}
