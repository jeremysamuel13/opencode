import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { BUDGET, original, render, turns } from "../src/session-title.ts"

// Fixtures go through the real schema so a shape the renderer reads cannot drift from what sessions store.
const message = Schema.decodeUnknownSync(SessionMessage.Info)
const base = (id: string) => ({ id: `msg_${id}`, time: { created: 0 } })
const user = (id: string, text: string) => message({ ...base(id), type: "user", text })
const assistant = (id: string, content: unknown[]) =>
  message({
    ...base(id),
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content,
    snapshot: {},
  })
const tool = { type: "tool", id: "t", name: "read", state: { status: "streaming", input: "" }, time: { created: 0 } }

describe("session-title", () => {
  it("sends an initial title request as the first message, untouched", () => {
    const text = `  Hello there ${"x".repeat(9_000)}`
    assert.equal(render([user("m1", text)], "initial"), text)
  })

  it("labels a regenerated request and clips the first message to 2,000 characters", () => {
    const text = render([user("m1", `FIRST ${"a".repeat(3_000)}`)])
    assert.equal(text, `Original request:\nFIRST ${"a".repeat(1_994)}`)
  })

  it("appends the turns after the first message: user text and assistant text parts only", () => {
    const history = [
      user("m1", "Make the parser faster"),
      assistant("a1", [
        tool,
        { type: "reasoning", text: "thinking" },
        { type: "text", text: " Done. " },
        { type: "text", text: "   " },
        { type: "text", text: "Next?" },
      ]),
      assistant("a2", [tool]),
      user("m2", " Now the lexer "),
    ]
    assert.deepEqual(turns(history), [
      { role: "assistant", text: "Done.\nNext?" },
      { role: "user", text: "Now the lexer" },
    ])
    assert.equal(
      render(history),
      "Original request:\nMake the parser faster\n\nRecent conversation:\nAssistant: Done.\nNext?\n\nUser: Now the lexer",
    )
  })

  it("keeps the newest turns within 8,000 characters", () => {
    const history = [user("m1", "First"), user("m2", `OLD ${"c".repeat(9_000)}`), user("m3", "NEW")]
    const text = render(history)
    assert.equal(BUDGET, 8_000)
    assert.equal(text.length, 8_000)
    assert.match(text, /^Original request:\nFirst\n\nRecent conversation:\nc+\n\nUser: NEW$/)
  })

  it("anchors on the first user message, wherever it is", () => {
    const history = [assistant("a1", [{ type: "text", text: "Hi" }]), user("m1", "First"), user("m2", "Second")]
    assert.equal(original(history), "First")
  })

  it("has no original request without a user message", () => {
    assert.equal(original([]), "")
  })

  it("renders nothing when the history has no user message", () => {
    assert.equal(render([]), "")
    const assistantOnly = [assistant("a1", [{ type: "text", text: "Hi" }])]
    assert.equal(render(assistantOnly, "initial"), "")
    assert.equal(render(assistantOnly), "")
  })
})
