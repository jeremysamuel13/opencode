/**
 * Renders the request a session title is generated from. OpenCode calls
 * `render` on the `title` hook's `history`; a plugin that wants a different
 * request can call these pieces itself and assign `messages`.
 */
import type { SessionMessage } from "@opencode/schema/session-message"

export type History = ReadonlyArray<SessionMessage.Info>

/** Default character budget of a rendered title request. */
export const BUDGET = 8_000
const MAX_ORIGINAL_LENGTH = 2_000
const MAX_SUMMARY_LENGTH = 1_500
// Turns are clipped one by one so a single long reply cannot push every other
// turn out of the window; a pasted blob keeps the ask before it and the question after it.
const MAX_USER_TURN_LENGTH = 1_000
const MAX_ASSISTANT_TURN_LENGTH = 600
const MAX_FILES = 12
const MAX_FILE_LENGTH = 200
// `path` is the v2 file-tool argument; `filePath` is its name in persisted v1 sessions.
const FILE_KEYS = ["path", "filePath"]

/** The session's first user message, which anchors the topic. */
export const original = (history: History) => history.find((message) => message.type === "user")?.text.trim() ?? ""

/** The latest completed compaction summary, standing in for history no longer in context. */
export const summary = (history: History) =>
  history
    .filter((message) => message.type === "compaction" && message.status === "completed")
    .findLast((message) => message.summary.trim().length > 0)
    ?.summary.trim()

const calls = (history: History) =>
  history.flatMap((message) =>
    message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
  )

/** Distinct tool names called, in first-use order. */
export const tools = (history: History) => [...new Set(calls(history).map((call) => call.name))]

/** Files read or changed by tools, in first-use order, relative to `directory` when inside it. */
export const files = (history: History, directory?: string) => {
  const prefix = directory ? `${directory.replace(/\/$/, "")}/` : undefined
  return [
    ...new Set(
      calls(history)
        .flatMap((call) => (call.state.status === "streaming" ? [] : [call.state]))
        // Per call: files the tool reported changing (edit, write, patch), then files named by its arguments (read).
        .flatMap((state) => {
          const reported = state.status === "completed" ? state.metadata?.files : undefined
          return [...(Array.isArray(reported) ? reported : []), ...FILE_KEYS.map((key) => state.input[key])]
        })
        .map((value) => (typeof value === "object" && value !== null && "file" in value ? value.file : value))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => (prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value)),
    ),
  ]
}

/** The conversation after the first user message: user text and the assistant's text parts, in order. */
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

const clip = (value: string, max: number) =>
  value.length <= max ? value : max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`
const clipMiddle = (value: string, max: number) => {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) * 0.6)
  return `${value.slice(0, head)}…${value.slice(value.length - (max - 1 - head))}`
}

/**
 * The text the title model reads. A history that is only the first user
 * message is sent bare. Anything more is labelled and held to `budget`: the
 * sections are head-clipped to it and the turns fill what remains, newest last.
 */
export function render(history: History, options: { budget?: number; directory?: string } = {}): string {
  const requested = options.budget ?? BUDGET
  const budget = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
  const compacted = summary(history)
  const used = tools(history)
  const touched = files(history, options.directory)
  const activity = [
    ...(used.length ? [`Tools used: ${used.join(", ")}`] : []),
    ...(touched.length
      ? [
          `Files touched: ${touched
            .slice(0, MAX_FILES)
            .map((file) => clip(file, MAX_FILE_LENGTH))
            .join(", ")}${touched.length > MAX_FILES ? ` (+${touched.length - MAX_FILES} more)` : ""}`,
        ]
      : []),
  ]
  const recent = turns(history)
    .map((turn) =>
      turn.role === "user"
        ? `User: ${clipMiddle(turn.text, MAX_USER_TURN_LENGTH)}`
        : `Assistant: ${clipMiddle(turn.text, MAX_ASSISTANT_TURN_LENGTH)}`,
    )
    .join("\n\n")
  if (!compacted && activity.length === 0 && !recent) return clip(original(history), budget)
  const sections = clip(
    [
      `Original request:\n${clip(original(history), MAX_ORIGINAL_LENGTH)}`,
      ...(compacted ? [`Summary of earlier conversation:\n${clip(compacted, MAX_SUMMARY_LENGTH)}`] : []),
      ...(activity.length ? [activity.join("\n")] : []),
    ].join("\n\n"),
    budget,
  )
  const prefix = `${sections}\n\nRecent conversation:\n`
  if (!recent || prefix.length >= budget) return sections
  return `${prefix}${recent.slice(-(budget - prefix.length))}`
}
