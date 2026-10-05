import { beforeEach, expect } from "bun:test"
import {
  AIError,
  LLMClient,
  LLMEvent,
  LanguageModel,
  Message,
  SystemPart,
  TransportError,
  type LLMRequest,
} from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTitle } from "@opencode/core/session/title"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { App } from "@opencode/core/app"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
let selectedSmall: Model.Info | undefined
let selections: Array<Session.Info["model"]> = []
const model = LanguageModel.make({
  id: "title-model",
  provider: "test",
  route: OpenAIChat.route,
})
const smallModel = LanguageModel.make({
  id: "title-small",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const successfulTitle = () =>
  Stream.make(
    LLMEvent.textDelta({ id: "title", text: "Generated Title\n" }),
    LLMEvent.stepFinish({
      index: 0,
      reason: { normalized: "stop" },
      usage: {
        inputTokens: 15,
        outputTokens: 6,
        nonCachedInputTokens: 10,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        reasoningTokens: 2,
      },
    }),
    LLMEvent.finish({
      reason: { normalized: "stop" },
    }),
  )
let titleStream: () => Stream.Stream<LLMEvent, AIError> = successfulTitle
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return titleStream()
  },
  generate: () => Effect.die("unused"),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => {
    selections.push(session.model)
    return Effect.succeed(
      SessionRunnerModel.resolved(session.model?.id === "title-small" ? smallModel : model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost,
        limit: { context: 200_000, output: 32_000 },
        variant: session.model?.variant,
      }),
    )
  },
})
const smallModels = Layer.mock(Model.Service, {
  small: () => Effect.succeed(selectedSmall),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      PluginHooks.node,
      SessionTitle.node,
    ]),
    [
      llmClient.replace(client),
      Model.node.replace(smallModels),
      SessionRunnerModel.node.replace(models),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      PluginSupervisor.node.replace(Layer.empty),
    ],
  ),
)

const insertSession = (id: Session.ID, title?: string, created?: number, model?: Model.Ref) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title,
        model,
        time_created: created,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const prompt = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const messageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID: messageID,
      item: { type: "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, {
      sessionID,
      inboxID: messageID,
    })
  })

const small = Model.Info.make({
  ...Model.Info.default(Provider.ID.make("test"), Model.ID.make("title-small")),
  family: Model.Family.make("gpt-luna"),
  capabilities: { tools: false, input: ["text"], output: ["text"] },
  variants: [
    { id: Model.VariantID.make("low") },
    { id: Model.VariantID.make("none") },
    { id: Model.VariantID.make("high") },
  ],
})
const lowSmall = Model.Info.make({
  ...small,
  variants: [{ id: Model.VariantID.make("low") }, { id: Model.VariantID.make("high") }],
})

beforeEach(() => {
  requests = []
  selectedSmall = undefined
  selections = []
  titleStream = successfulTitle
})

const enableTitleAgent = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("title"), (agent) => {
      agent.mode = "primary"
      agent.hidden = true
      agent.system = "You are a title generator."
    })
  })
})

it.effect("generates a title from the sole user message and renames the session", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_generate")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.http?.headers).toEqual({
      "x-opencode-session-id": sessionID,
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "User-Agent": App.useragent(App.make()),
      "x-opencode-project": Project.ID.global,
      "x-opencode-session": sessionID,
      "x-opencode-client": "opencode",
    })
    expect(requests[0]?.promptCacheKey).toBe(sessionID)
    expect(requests[0]?.tools).toEqual([])
    expect(requests[0]?.system.map((part) => part.text)).toEqual(["You are a title generator."])
    expect(JSON.stringify(requests[0]?.messages)).toContain("Help me debug the failing build")
    const renamed = yield* store.get(sessionID)
    expect(renamed?.title).toBe("Generated Title")
    expect(renamed?.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } })
    expect(renamed?.cost).toBeCloseTo(0.0000233)
  }),
)

it.effect("runs title hooks instead of context hooks", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_hook")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Redact this message")

    const hooks = yield* PluginHooks.Service
    let contexts = 0
    yield* hooks.register("session", "context", () => Effect.sync(() => contexts++))
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        expect(event.sessionID).toBe(sessionID)
        expect(event.system.map((part) => part.text)).toEqual(["You are a title generator."])
        event.system.push(SystemPart.make("Prefer short titles."))
        event.messages = [Message.user("[redacted]")]
        event.options.maxTokens = 32
        event.options.reasoningEffort = "low"
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(contexts).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.system.map((part) => part.text)).toEqual(["You are a title generator.", "Prefer short titles."])
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("Redact this message")
    expect(requests[0]?.generation).toEqual(expect.objectContaining({ maxTokens: 32 }))
    expect(requests[0]?.providerOptions).toEqual({ reasoningEffort: "low" })
  }),
)

it.effect("uses a hook-provided title without a model request", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_result")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Hello")

    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.result = "Plugin Title"
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests).toHaveLength(0)
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Plugin Title")
  }),
)

it.effect("uses a small model from the primary provider", () =>
  Effect.gen(function* () {
    selectedSmall = small
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_small_model")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Use a small model for this title")

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests.map((request) => String(request.model.id))).toEqual(["title-small"])
    expect(selections[1]?.variant).toBe(Model.VariantID.make("none"))
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("falls back to the primary model when the small model fails", () =>
  Effect.gen(function* () {
    titleStream = () =>
      requests.length === 1
        ? Stream.make(LLMEvent.providerError({ message: "Small model unavailable" }))
        : successfulTitle()
    selectedSmall = lowSmall
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_small_fallback")
    yield* insertSession(
      sessionID,
      undefined,
      undefined,
      Model.Ref.make({
        providerID: Provider.ID.make("test"),
        id: Model.ID.make("title-model"),
        variant: Model.VariantID.make("high"),
      }),
    )
    yield* prompt(sessionID, "Fall back when title generation fails")

    const attempted: Model.Ref[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "model.request", (event) =>
      Effect.sync(() => {
        attempted.push(event.model)
      }),
    )
    const seen: number[] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        seen.push(event.history.length)
        event.history.length = 0
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests.map((request) => String(request.model.id))).toEqual(["title-small", "title-model"])
    expect(attempted.map((model) => String(model.variant))).toEqual(["low", "high"])
    // The fallback attempt starts from the session's history, not the first attempt's edits.
    expect(seen).toEqual([1, 1])
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("generates from the first user message after later messages exist", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_second_message")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "First message")
    yield* prompt(sessionID, "Second message")

    const store = yield* SessionStore.Service
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain("First message")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("Second message")
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("retries a legacy persisted fallback title", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_legacy")
    const created = Date.parse("2026-07-30T18:45:03.662Z")
    yield* insertSession(sessionID, "New session - 2026-07-30T18:45:03.662Z", created)
    yield* prompt(sessionID, "Retry the legacy title")

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(1)
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("generates a title for an explicitly requested child session", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_child")
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        parent_id: Session.ID.make("ses_title_parent"),
        slug: sessionID,
        directory: "/project",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* prompt(sessionID, "Do this subtask")

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(1)
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("does not generate when the title agent is removed", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_title_no_agent")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests).toHaveLength(0)
    const untouched = yield* store.get(sessionID)
    expect(untouched?.title).toBeUndefined()
  }),
)

it.effect("regenerates an existing title using the title agent", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Investigate the login failure")
    const events = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ id: Model.ID.make("title-model"), providerID: Provider.ID.make("test") }),
      started: 0,
    })
    yield* events.publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* events.publish(SessionEvent.Reasoning.Ended, {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text: "Private reasoning that should not appear",
    })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 1 })
    yield* events.publish(SessionEvent.Text.Ended, {
      sessionID,
      assistantMessageID,
      ordinal: 1,
      text: "The actual issue is expired OAuth credentials.",
    })
    yield* prompt(sessionID, "Switch to fixing OAuth token refresh")

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(1)
    expect(requests[0]?.system.map((part) => part.text)).toEqual(["You are a title generator."])
    expect(JSON.stringify(requests[0]?.messages)).toContain("Investigate the login failure")
    expect(JSON.stringify(requests[0]?.messages)).toContain("The actual issue is expired OAuth credentials.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Switch to fixing OAuth token refresh")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("Private reasoning that should not appear")
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("bounds regeneration context while preserving the original request and recent conversation", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate_bounded")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, `ORIGINAL_GOAL ${"a".repeat(3_000)} OMITTED_ORIGINAL_END`)
    yield* prompt(sessionID, `OMITTED_OLD_TURN ${"c".repeat(900)}`)
    yield* Effect.forEach(
      Array.from({ length: 12 }, (_, index) => `filler turn ${index} ${"d".repeat(900)}`),
      (text) => prompt(sessionID, text),
    )
    yield* prompt(sessionID, `RECENT_ASK ${"b".repeat(3_000)} OMITTED_MIDDLE ${"b".repeat(3_000)} RECENT_GOAL`)

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text.length).toBeLessThanOrEqual(8_000)
    expect(content.text).toContain("ORIGINAL_GOAL")
    expect(content.text).not.toContain("OMITTED_ORIGINAL_END")
    // A long turn keeps both ends: the ask before a pasted blob and the question after it.
    expect(content.text).toContain("RECENT_ASK")
    expect(content.text).toContain("RECENT_GOAL")
    expect(content.text).not.toContain("OMITTED_MIDDLE")
    // The oldest ask sits outside the retained window.
    expect(content.text).not.toContain("OMITTED_OLD_TURN")
  }),
)

it.effect("clips a long assistant reply on its own, keeping both ends", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate_assistant_clip")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Explain the parser")
    const events = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ id: Model.ID.make("title-model"), providerID: Provider.ID.make("test") }),
      started: 0,
    })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* events.publish(SessionEvent.Text.Ended, {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text: `REPLY_HEAD ${"e".repeat(2_000)} OMITTED_REPLY_MIDDLE ${"e".repeat(2_000)} REPLY_TAIL`,
    })
    yield* prompt(sessionID, "Thanks, now the lexer")

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    const reply = content.text.match(/Assistant: .*/)?.[0] ?? ""
    expect(reply.length).toBeLessThanOrEqual("Assistant: ".length + 600)
    expect(reply).toContain("REPLY_HEAD")
    expect(reply).toContain("REPLY_TAIL")
    expect(reply).not.toContain("OMITTED_REPLY_MIDDLE")
    expect(content.text).toContain("User: Thanks, now the lexer")
  }),
)

it.effect("regeneration context names the tools and files touched", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate_activity")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    const events = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ id: Model.ID.make("title-model"), providerID: Provider.ID.make("test") }),
      started: 0,
    })
    const call = (id: string, name: string, input: Record<string, unknown>, metadata?: Record<string, Schema.Json>) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id, name })
        yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, id, input, executed: true })
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID,
          id,
          content: [{ type: "text", text: "ok" }],
          executed: true,
          ...(metadata ? { metadata } : {}),
        })
      })
    // v2 tools name the file in `path`; edit/write/patch also report what they changed in `metadata.files`.
    yield* call("t0", "read", { path: "/project/README.md" })
    yield* call("t1", "read", { path: "/project/src/parser.ts" })
    yield* call("t2", "read", { path: "/project/src/parser.ts" })
    yield* call(
      "t3",
      "edit",
      { path: "/project/src/parser.ts", oldString: "a", newString: "b" },
      { files: [{ file: "/project/src/parser.ts" }] },
    )
    yield* call(
      "t4",
      "patch",
      { patchText: "*** Begin Patch" },
      { files: [{ file: "/project/src/lexer.ts" }, { file: "/elsewhere/notes.md" }] },
    )
    yield* call("t5", "shell", { command: "bun test" })
    // Persisted v1 sessions used `filePath`.
    yield* call("t6", "edit", { filePath: "/project/src/legacy.ts" })
    yield* Effect.forEach(
      Array.from({ length: 10 }, (_, index) => index),
      (index) => call(`extra-${index}`, "read", { path: `/project/src/extra-${index}.ts` }),
    )
    // A call still streaming its arguments has no input to name files from.
    yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id: "t7", name: "write" })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 20 })
    yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 20, text: "Done." })

    const hooks = yield* PluginHooks.Service
    const seen: string[] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        expect(event.directory).toBe("/project")
        const first = event.messages[0]?.content[0]
        if (first?.type === "text") seen.push(first.text)
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    // The hook saw the same request the model received.
    expect(seen).toEqual([content.text])
    expect(content.text).toContain("Tools used: read, edit, patch, shell, write")
    expect(content.text).toContain(
      "Files touched: README.md, src/parser.ts, src/lexer.ts, /elsewhere/notes.md, src/legacy.ts, src/extra-0.ts, src/extra-1.ts, src/extra-2.ts, src/extra-3.ts, src/extra-4.ts, src/extra-5.ts, src/extra-6.ts (+3 more)",
    )
    expect(content.text).not.toContain("oldString")
    expect(content.text).not.toContain("patchText")
  }),
)

it.effect("regeneration context carries a completed compaction summary", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate_summary")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    const events = yield* Bus.Service
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
    yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID,
      reason: "manual",
      text: "OLDER_SUMMARY",
      recent: "",
    })
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
    yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID,
      reason: "manual",
      text: "Parser was profiled; hot path is tokenize().",
      recent: "",
    })
    yield* prompt(sessionID, "Now vectorize tokenize()")
    // A compaction still running has nothing to contribute yet.
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text).toContain("Original request:\nMake the parser faster")
    expect(content.text).toContain("Summary of earlier conversation:\nParser was profiled; hot path is tokenize().")
    expect(content.text).not.toContain("OLDER_SUMMARY")
    expect(content.text).toContain("Recent conversation:\nUser: Now vectorize tokenize()")
  }),
)

it.effect("clips a regenerated request that is only a long first message to the budget", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_budget_alone")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, `LONG_FIRST ${"a".repeat(9_000)}`)
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text.startsWith("LONG_FIRST")).toBe(true)
    expect(content.text.length).toBe(8_000)
  }),
)

it.effect("clips the labelled sections and drops the turns when a hook shrinks the budget below them", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.budget = 40
      }),
    )
    const sessionID = Session.ID.make("ses_title_budget_tight")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster than before")
    yield* prompt(sessionID, "RECENT_TURN that must not appear")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text.length).toBe(40)
    expect(content.text.startsWith("Original request:\nMake the parser")).toBe(true)
    expect(content.text).not.toContain("RECENT_TURN")
  }),
)

it.effect("treats a non-finite budget as nothing to spend", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.budget = Infinity
      }),
    )
    const sessionID = Session.ID.make("ses_title_budget_infinite")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    yield* prompt(sessionID, "RECENT_TURN")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(requests[0]?.messages[0]?.content[0]).toEqual({ type: "text", text: "" })
  }),
)

it.effect("renders the title request from the history a hook reshaped", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_history_hook")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    yield* prompt(sessionID, "SECRET_TURN that must not reach the model")
    yield* prompt(sessionID, "Now vectorize tokenize()")

    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        expect(event.history.map((message) => message.type)).toEqual(["user", "user", "user"])
        expect(event.messages[0]?.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("SECRET_TURN"),
        })
        event.history = event.history.filter((message) => message.type !== "user" || !message.text.includes("SECRET"))
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text).toBe(
      "Original request:\nMake the parser faster\n\nRecent conversation:\nUser: Now vectorize tokenize()",
    )
  }),
)

it.effect("keeps a title request whose messages a hook edited in place", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_messages_spliced")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Secret: do not send")
    yield* prompt(sessionID, "Follow-up")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages.splice(0, event.messages.length, Message.user("[redacted]"))
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests[0]?.messages[0]?.content[0]).toEqual({ type: "text", text: "[redacted]" })
  }),
)

it.effect("sends no request text when a hook empties messages in place", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_messages_emptied")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Secret: do not send")
    yield* prompt(sessionID, "Follow-up")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages.length = 0
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests[0]?.messages).toEqual([])
  }),
)

it.effect("keeps messages a hook assigned even when it also edits the history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_messages_assigned")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Keep this request")
    yield* prompt(sessionID, "Follow-up")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages = [...event.messages]
        event.history = []
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text).toContain("Original request:\nKeep this request")
  }),
)

it.effect("sends the initial title request as the bare first message", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_initial_bare")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Hello there")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(requests[0]?.messages[0]?.content[0]).toEqual({ type: "text", text: "Hello there" })
  }),
)

it.effect("gives title hooks the initial request as a one-message history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const hooks = yield* PluginHooks.Service
    const histories: string[][] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        histories.push(event.history.map((message) => message.type))
      }),
    )
    const sessionID = Session.ID.make("ses_title_initial_history")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Hello again")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(histories).toEqual([["user"]])
    expect(requests[0]?.messages[0]?.content[0]).toEqual({ type: "text", text: "Hello again" })
  }),
)

it.effect("holds an initial title request to a budget a hook set", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.budget = 60
      }),
    )
    const sessionID = Session.ID.make("ses_title_initial_budget")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, `LONG_FIRST ${"a".repeat(10_000)}`)
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text.length).toBe(60)
    expect(content.text.startsWith("LONG_FIRST")).toBe(true)
  }),
)

it.effect("tells title hooks whether the title is initial or regenerated", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const reasons: string[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        reasons.push(event.reason)
      }),
    )
    const title = yield* SessionTitle.Service
    const fresh = Session.ID.make("ses_title_reason_initial")
    yield* insertSession(fresh)
    yield* prompt(fresh, "Hello")
    yield* title.generate(fresh)
    const titled = Session.ID.make("ses_title_reason_regenerate")
    yield* insertSession(titled, "Original title")
    yield* prompt(titled, "Hello again")
    yield* title.generate(titled)
    expect(reasons).toEqual(["initial", "regenerate"])
  }),
)

it.effect("preserves the existing title when regeneration fails", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate_failure")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Fail to regenerate this title")
    titleStream = () => Stream.make(LLMEvent.providerError({ message: "Provider unavailable" }))

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(1)
    expect((yield* store.get(sessionID))?.title).toBe("Original title")
  }),
)

it.effect("retries after a failed title request", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_retry")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Retry this title")
    const title = yield* SessionTitle.Service
    titleStream = () => Stream.make(LLMEvent.providerError({ message: "Provider unavailable" }))

    yield* title.generate(sessionID)
    titleStream = successfulTitle
    yield* title.generate(sessionID)

    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(2)
    expect((yield* store.get(sessionID))?.title).toBe("Generated Title")
  }),
)

it.effect("does not rename after a failed title stream", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_stream_failure")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Fail this title stream")
    titleStream = () =>
      Stream.fail(
        new AIError({
          reason: new TransportError({ message: "Disconnected", transport: "http", operation: "request" }),
        }),
      )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(1)
    expect((yield* store.get(sessionID))?.title).toBeUndefined()
  }),
)

it.effect("preserves a manual rename completed while generation is in flight", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_manual_rename")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Generate this title")
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    titleStream = () =>
      Stream.unwrap(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(successfulTitle()),
        ),
      )
    const title = yield* SessionTitle.Service
    const fiber = yield* title.generate(sessionID).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    const events = yield* Bus.Service
    yield* events.publish(SessionEvent.Renamed, { sessionID, title: "Manual title" })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(fiber)

    const store = yield* SessionStore.Service
    expect(requests).toHaveLength(1)
    expect((yield* store.get(sessionID))?.title).toBe("Manual title")
  }),
)
