import { beforeEach, expect } from "bun:test"
import {
  AIError,
  LLMClient,
  LLMEvent,
  LanguageModel,
  Media,
  Message,
  SystemPart,
  TransportError,
  type LLMRequest,
} from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { render } from "@opencode/plugin/session-title"
import type { Prompt } from "@opencode/schema/prompt"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
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
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
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

const prompt = (sessionID: Session.ID, text: string, files?: Prompt["files"]) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const messageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID: messageID,
      item: { type: "user", payload: { text, files }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, {
      sessionID,
      inboxID: messageID,
    })
  })

const answer = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("title-model") }),
      started: 0,
    })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
  })

const sent = () => requests.map((request) => request.messages.map(({ role, content }) => ({ role, content })))

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

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests.map((request) => String(request.model.id))).toEqual(["title-small", "title-model"])
    expect(attempted.map((model) => String(model.variant))).toEqual(["low", "high"])
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

it.effect("renders the title request from the history a hook reshaped", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_history_hook")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    yield* prompt(sessionID, "SECRET_TURN that must not reach the model")
    yield* prompt(sessionID, "Now vectorize tokenize()")

    const hooks = yield* PluginHooks.Service
    const given: unknown[] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        given.push(
          event.history.map((message) => message.type),
          event.messages[0]?.content[0],
        )
        event.history = event.history.filter((message) => message.type !== "user" || !message.text.includes("SECRET"))
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(given).toEqual([
      ["user", "user", "user"],
      {
        type: "text",
        text: "Original request:\nMake the parser faster\n\nRecent conversation:\nUser: SECRET_TURN that must not reach the model\n\nUser: Now vectorize tokenize()",
      },
    ])
    expect(sent()).toEqual([
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Original request:\nMake the parser faster\n\nRecent conversation:\nUser: Now vectorize tokenize()",
            },
          ],
        },
      ],
    ])
  }),
)

it.effect("renders the title request from a history a hook reordered and edited in place", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_history_reordered")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "First")
    yield* prompt(sessionID, "Second")
    yield* prompt(sessionID, "Third")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history.reverse()
        event.history.splice(1, 1)
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    // The first user message in the reordered history anchors the request.
    expect(requests[0]?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Original request:\nThird\n\nRecent conversation:\nUser: First",
    })
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

    expect(sent()).toEqual([[{ role: "user", content: [{ type: "text", text: "[redacted]" }] }]])
  }),
)

it.effect("keeps a message a hook pushed onto the title request", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_messages_pushed")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Keep this request")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages.push(Message.user("Branch: main"))
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests[0]?.messages.map((message) => message.content[0])).toEqual([
      { type: "text", text: "Original request:\nKeep this request" },
      { type: "text", text: "Branch: main" },
    ])
  }),
)

it.effect("keeps a title request whose text a hook redacted inside the message", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_messages_redacted")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Token SECRET_TOKEN leaked")
    yield* prompt(sessionID, "Follow-up")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        const part = event.messages[0]?.content[0]
        if (part?.type === "text") Object.assign(part, { text: part.text.replace("SECRET_TOKEN", "[redacted]") })
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(sent()).toEqual([
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Original request:\nToken [redacted] leaked\n\nRecent conversation:\nUser: Follow-up",
            },
          ],
        },
      ],
    ])
  }),
)

it.effect("keeps a message a hook replaced with an equal one inside the title request", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_messages_equal")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Keep this request")
    yield* prompt(sessionID, "Drop this turn")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages[0] = Message.user(event.messages[0]!.content)
        event.history = event.history.slice(0, 1)
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    // A hook that changed messages has the final say, even with an equal value.
    expect(requests[0]?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Original request:\nKeep this request\n\nRecent conversation:\nUser: Drop this turn",
    })
  }),
)

it.effect("skips the title request when a hook empties messages in place", () =>
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

    expect(requests).toEqual([])
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Original title")
  }),
)

it.effect("uses a hook-provided title even when the history has no user message left", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_result_over_empty")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Hello")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history = []
        event.result = "Hook title"
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(requests).toEqual([])
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Hook title")
  }),
)

it.effect("skips the title request when a hook empties the history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_history_emptied")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Secret: do not send")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history = []
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests).toEqual([])
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Original title")
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

    expect(requests[0]?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Original request:\nKeep this request\n\nRecent conversation:\nUser: Follow-up",
    })
  }),
)

it.effect("gives initial title hooks the whole history but sends only the first message", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const hooks = yield* PluginHooks.Service
    const histories: string[][] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        histories.push(event.history.map((message) => (message.type === "user" ? message.text : message.type)))
      }),
    )
    const sessionID = Session.ID.make("ses_title_initial_history")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Hello again")
    yield* prompt(sessionID, "And more")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(histories).toEqual([["Hello again", "And more"]])
    expect(requests[0]?.messages[0]?.content[0]).toEqual({ type: "text", text: "Hello again" })
  }),
)

it.effect("still requests an initial title for a first prompt without text", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_image_only")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "", [{ mime: "image/png", data: "iVBORw0KGgo=", source: { type: "inline" } }])
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(sent()).toEqual([[{ role: "user", content: [{ type: "text", text: "" }] }]])
  }),
)

it.effect("shows initial title hooks the bare first message as the request", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const hooks = yield* PluginHooks.Service
    const given: unknown[] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        given.push(event.messages.map((message) => message.content))
      }),
    )
    const sessionID = Session.ID.make("ses_title_initial_request")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Hello again")
    yield* prompt(sessionID, "And more")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(given).toEqual([[[{ type: "text", text: "Hello again" }]]])
  }),
)

it.effect("anchors an initial title on the first user message a hook left in the history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_initial_reanchored")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "OLD_ANCHOR with a secret")
    yield* prompt(sessionID, "New anchor")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history = event.history.filter((message) => message.type !== "user" || !message.text.includes("OLD"))
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(sent()).toEqual([[{ role: "user", content: [{ type: "text", text: "New anchor" }] }]])
  }),
)

it.effect("lets a later hook rebuild the request from an earlier hook's history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_rebuild")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    yield* prompt(sessionID, "SECRET_TURN that must not reach the model")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history = event.history.filter((message) => message.type !== "user" || !message.text.includes("SECRET"))
      }),
    )
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages = [Message.user(`${render(event.history, event.reason)}\n\nBranch: main`)]
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(sent()).toEqual([
      [
        {
          role: "user",
          content: [{ type: "text", text: "Original request:\nMake the parser faster\n\nBranch: main" }],
        },
      ],
    ])
  }),
)

it.effect("tells title hooks a legacy fallback title is initial", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const reasons: string[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) => Effect.sync(() => void reasons.push(event.reason)))
    const sessionID = Session.ID.make("ses_title_reason_legacy")
    yield* insertSession(sessionID, "New session - 2026-07-30T18:45:03.662Z", Date.parse("2026-07-30T18:45:03.662Z"))
    yield* prompt(sessionID, "Retry the legacy title")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(reasons).toEqual(["initial"])
  }),
)

it.effect("tells title hooks an untitled session's title is initial", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const reasons: string[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) => Effect.sync(() => void reasons.push(event.reason)))
    const sessionID = Session.ID.make("ses_title_reason_initial")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Hello")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(reasons).toEqual(["initial"])
  }),
)

it.effect("tells title hooks a titled session's title is regenerated", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const reasons: string[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) => Effect.sync(() => void reasons.push(event.reason)))
    const sessionID = Session.ID.make("ses_title_reason_regenerate")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Hello again")
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(reasons).toEqual(["regenerate"])
  }),
)

it.effect("gives a fallback attempt the session history, not the first attempt's edits", () =>
  Effect.gen(function* () {
    titleStream = () =>
      requests.length === 1
        ? Stream.make(LLMEvent.providerError({ message: "Small model unavailable" }))
        : successfulTitle()
    selectedSmall = lowSmall
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_fallback_history")
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
    yield* prompt(sessionID, "Second turn")

    const seen: number[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        seen.push(event.history.length)
        event.history.length = 1
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(requests.map((request) => String(request.model.id))).toEqual(["title-small", "title-model"])
    expect(seen).toEqual([2, 2])
  }),
)

it.effect("sends a media-only request a hook assigned", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_media_only_request")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Hello")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.messages = [Message.user([Message.media(Media.base64("iVBORw0KGgo=", "image/png"))])]
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(sent().map((messages) => messages.map((message) => message.content.map((part) => part.type)))).toEqual([
      [["media"]],
    ])
  }),
)

it.effect("skips the title request when a hook leaves only assistant turns in the history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_assistant_only")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "First")
    yield* answer(sessionID, "An answer")
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history = event.history.filter((message) => message.type === "assistant")
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)
    expect(requests).toEqual([])
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Original title")
  }),
)

it.effect("does not try the fallback model when a hook set an empty title", () =>
  Effect.gen(function* () {
    selectedSmall = lowSmall
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_empty_result_no_fallback")
    yield* insertSession(
      sessionID,
      "Original title",
      undefined,
      Model.Ref.make({
        providerID: Provider.ID.make("test"),
        id: Model.ID.make("title-model"),
        variant: Model.VariantID.make("high"),
      }),
    )
    yield* prompt(sessionID, "Hello")

    const models: string[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        models.push(String(event.model.id))
        event.result = ""
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(models).toEqual(["title-small"])
    expect(requests).toEqual([])
    const store = yield* SessionStore.Service
    expect((yield* store.get(sessionID))?.title).toBe("Original title")
  }),
)

it.effect("does not try the fallback model when a hook skipped the title", () =>
  Effect.gen(function* () {
    selectedSmall = lowSmall
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_skip_no_fallback")
    yield* insertSession(
      sessionID,
      "Original title",
      undefined,
      Model.Ref.make({
        providerID: Provider.ID.make("test"),
        id: Model.ID.make("title-model"),
        variant: Model.VariantID.make("high"),
      }),
    )
    yield* prompt(sessionID, "Skip me on the small model")

    const models: string[] = []
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        models.push(String(event.model.id))
        if (event.model.id === small.id) event.history = []
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(models).toEqual(["title-small"])
    expect(requests).toEqual([])
  }),
)

it.effect("accepts the README title example: a plain message literal and a history without assistant turns", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_readme")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "First")
    yield* answer(sessionID, "An answer")
    yield* prompt(sessionID, "Second")

    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        event.history = event.history.filter((message) => message.type !== "assistant")
        if (event.reason === "regenerate")
          event.messages = [
            { role: "user", content: [{ type: "text", text: `${render(event.history)}\n\nBranch: main` }] },
          ]
      }),
    )

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(sent()).toEqual([
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Original request:\nFirst\n\nRecent conversation:\nUser: Second\n\nBranch: main" },
          ],
        },
      ],
    ])
  }),
)

it.effect("gives title hooks the first user message and the context window as history", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_history_window")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    yield* prompt(sessionID, "A turn the compaction leaves behind")
    const events = yield* Bus.Service
    yield* events.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
    yield* events.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "SUMMARY", recent: "" })
    yield* prompt(sessionID, "Now vectorize tokenize()")

    const hooks = yield* PluginHooks.Service
    const histories: string[][] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        histories.push(event.history.map((message) => message.type))
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    // The window starts at the compaction; the first user message is put back in front of it.
    expect(histories).toEqual([["user", "compaction", "user"]])
    // The default request is unchanged: a compaction summary is there for hooks, not for the model.
    expect(requests[0]?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Original request:\nMake the parser faster\n\nRecent conversation:\nUser: Now vectorize tokenize()",
    })
  }),
)

it.effect("falls back to the first message alone when the context window cannot be read", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_history_unreadable")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, "Make the parser faster")
    yield* prompt(sessionID, "A readable turn")
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values({ id: SessionMessage.ID.create(), session_id: sessionID, type: "assistant", seq: 99, data: {} as never })
      .run()
      .pipe(Effect.orDie)

    const hooks = yield* PluginHooks.Service
    const histories: string[][] = []
    yield* hooks.register("session", "title", (event) =>
      Effect.sync(() => {
        histories.push(event.history.map((message) => message.type))
      }),
    )
    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    expect(histories).toEqual([["user"]])
    expect(requests[0]?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Original request:\nMake the parser faster",
    })
  }),
)

it.effect("bounds regeneration context while preserving the original request and recent conversation", () =>
  Effect.gen(function* () {
    yield* enableTitleAgent
    const sessionID = Session.ID.make("ses_title_regenerate_bounded")
    yield* insertSession(sessionID, "Original title")
    yield* prompt(sessionID, `ORIGINAL_GOAL ${"a".repeat(3_000)} OMITTED_ORIGINAL_END`)
    yield* prompt(sessionID, `OMITTED_OLD_CONTEXT ${"b".repeat(9_000)} RECENT_GOAL`)

    const title = yield* SessionTitle.Service
    yield* title.generate(sessionID)

    const content = requests[0]?.messages[0]?.content[0]
    expect(content?.type).toBe("text")
    if (content?.type !== "text") return
    expect(content.text.length).toBeLessThanOrEqual(8_000)
    expect(content.text).toContain("ORIGINAL_GOAL")
    expect(content.text).toContain("RECENT_GOAL")
    expect(content.text).not.toContain("OMITTED_ORIGINAL_END")
    expect(content.text).not.toContain("OMITTED_OLD_CONTEXT")
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
