import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer, generatedTitles } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("plugins rename a session with a title and regenerate it with an empty one", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const context = yield* PluginHost.make(plugins)
    const created = yield* context.session.create({ title: "Plugin title" })

    yield* context.session.update({ sessionID: created.id, title: "Renamed by plugin" })
    expect((yield* sessions.get(created.id)).title).toBe("Renamed by plugin")
    expect(generatedTitles).toEqual([])

    yield* context.session.update({ sessionID: created.id, title: "" })
    expect((yield* sessions.get(created.id)).title).toBe("Renamed by plugin")
    expect(generatedTitles).toEqual([created.id])
  }),
)
