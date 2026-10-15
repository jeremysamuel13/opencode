/**
 * Renders the request a session title is generated from. OpenCode calls
 * `render` on the `title` hook's `history`; a plugin that wants a different
 * request composes these pieces itself and assigns `messages`.
 */
import type { SessionMessage } from "@opencode/schema/session-message"
import type { SessionTitle } from "./promise/session.js"

export type History = ReadonlyArray<SessionMessage.Info>
export type Reason = SessionTitle["reason"]

/** Character budget of a regenerated title request; an initial request is the first message as-is. */
export const BUDGET = 8_000
const MAX_ORIGINAL_LENGTH = 2_000

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
 * anchor a title. An `initial` title is generated from the first user message
 * as-is. A `regenerate` one (the default) labels the first message, clipped to
 * 2,000 characters, and fills the rest of `BUDGET` with the end of the turns.
 */
export function render(history: History, reason: Reason = "regenerate"): string {
  if (!history.some((message) => message.type === "user")) return ""
  const first = original(history)
  if (reason === "initial") return first
  const labelled = `Original request:\n${first.slice(0, MAX_ORIGINAL_LENGTH)}`
  const recent = turns(history)
    .map((turn) => (turn.role === "user" ? `User: ${turn.text}` : `Assistant: ${turn.text}`))
    .join("\n\n")
  if (!recent) return labelled
  const prefix = `${labelled}\n\nRecent conversation:\n`
  return `${prefix}${recent.slice(-(BUDGET - prefix.length))}`
}
