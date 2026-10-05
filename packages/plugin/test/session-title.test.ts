import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { files, render, summary, tools, turns } from "../src/session-title.ts"

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
const tool = (name: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) => ({
  type: "tool",
  id: `${name}-${JSON.stringify(input)}`,
  name,
  state: { status: "completed", input, content: [{ type: "text", text: "ok" }], ...(metadata ? { metadata } : {}) },
  time: { created: 0 },
})
const compaction = (id: string, status: "completed" | "running", text: string) =>
  message({ ...base(id), type: "compaction", status, reason: "manual", summary: text, recent: "" })

describe("session-title", () => {
  it("renders a lone first message bare, clipped to the budget", () => {
    assert.equal(render([user("m1", "Hello there")]), "Hello there")
    assert.equal(render([user("m1", "x".repeat(20))], { budget: 10 }).length, 10)
  })

  it("derives tools, files and turns from the message union", () => {
    const history = [
      user("m1", "Make the parser faster"),
      assistant("a1", [
        tool("read", { path: "/project/README.md" }),
        tool(
          "edit",
          { path: "/project/src/parser.ts", oldString: "a" },
          { files: [{ file: "/project/src/parser.ts" }] },
        ),
        tool("patch", { patchText: "***" }, { files: [{ file: "/elsewhere/notes.md" }] }),
        { type: "tool", id: "s", name: "write", state: { status: "streaming", input: "" }, time: { created: 0 } },
        { type: "text", text: "Done." },
      ]),
      user("m2", "Now the lexer"),
    ]
    assert.deepEqual(tools(history), ["read", "edit", "patch", "write"])
    assert.deepEqual(files(history, "/project/"), ["README.md", "src/parser.ts", "/elsewhere/notes.md"])
    assert.deepEqual(turns(history), [
      { role: "assistant", text: "Done." },
      { role: "user", text: "Now the lexer" },
    ])
    assert.equal(
      render(history, { directory: "/project" }),
      [
        "Original request:\nMake the parser faster",
        "Tools used: read, edit, patch, write\nFiles touched: README.md, src/parser.ts, /elsewhere/notes.md",
        "Recent conversation:\nAssistant: Done.\n\nUser: Now the lexer",
      ].join("\n\n"),
    )
  })

  it("lists at most twelve files, each clipped to 200 characters", () => {
    const history = [
      user("m1", "First"),
      assistant("a1", [
        tool("read", { path: `/p/${"f".repeat(300)}` }),
        tool("edit", {}, { files: Array.from({ length: 14 }, (_, i) => ({ file: `/p/f${i}.ts` })) }),
      ]),
    ]
    const line = render(history, { directory: "/p" }).match(/Files touched: .*/)?.[0] ?? ""
    assert.equal(line.split(", ").length, 12)
    assert.match(line, /^Files touched: f{199}…, f0\.ts/)
    assert.match(line, / \(\+3 more\)$/)
  })

  it("uses the latest completed compaction summary, clipped", () => {
    const history = [
      user("m1", "First"),
      compaction("c1", "completed", "OLDER"),
      compaction("c2", "completed", `Parser was profiled. ${"s".repeat(2_000)}`),
      compaction("c3", "running", "partial"),
      user("m2", "Next"),
    ]
    assert.match(summary(history) ?? "", /^Parser was profiled\./)
    const text = render(history)
    assert.match(text, /Summary of earlier conversation:\nParser was profiled\. s+…\n/)
    assert.equal(text.match(/Summary of earlier conversation:\n(.*)\n/)?.[1].length, 1_500)
    assert.doesNotMatch(text, /OLDER|partial/)
  })

  it("holds the whole request to the budget, keeping the newest turns", () => {
    const history = [user("m1", "First"), user("m2", `OLD ${"c".repeat(900)}`), user("m3", `NEW ${"d".repeat(100)}`)]
    const text = render(history, { budget: 200.9 })
    assert.equal(text.length, 200)
    assert.match(text, /^Original request:\nFirst/)
    assert.match(text, /NEW/)
    assert.doesNotMatch(text, /OLD/)
    for (const budget of [Number.NaN, -5, Number.POSITIVE_INFINITY]) assert.equal(render(history, { budget }), "")
  })
})
