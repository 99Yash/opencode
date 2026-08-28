import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Layer } from "effect"
import { CommandInvocation } from "@opencode-ai/core/command/invocation"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { ShellSelect } from "@opencode-ai/core/shell/select"
import { Agent } from "@opencode-ai/schema/agent"
import { ConfigCommand } from "@opencode-ai/schema/config/command"
import { Model } from "@opencode-ai/schema/model"
import { Money } from "@opencode-ai/schema/money"
import { Provider } from "@opencode-ai/schema/provider"
import { Session } from "@opencode-ai/schema/session"
import { SessionInbox } from "@opencode-ai/schema/session-inbox"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { AppProcess } from "@opencode-ai/util/process"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const shell = ShellSelect.Service.of({
  resolve: (input) =>
    Effect.sync(() => {
      expect(input).toEqual({ priority: "config" })
      return "sh"
    }),
  transform: () => Effect.die("unused shell.transform"),
  reload: () => Effect.die("unused shell.reload"),
})
const it = testEffect(
  Layer.mergeAll(AppNodeBuilder.build(AppProcess.node), tempLocationLayer, Layer.succeed(ShellSelect.Service, shell)),
)
const sessionID = Session.ID.make("ses_command_invocation")

describe("CommandInvocation", () => {
  it.effect("expands arguments without changing unconfigured session defaults or prompt attachments", () =>
    Effect.gen(function* () {
      const prompts: unknown[] = []
      const invoke = yield* CommandInvocation.make(promptHost(prompts))
      const files = [{ uri: "file:///context.md", name: "context" }]
      for (const [template, text, expected] of [
        [
          "$2 / $1 / $2",
          `"alpha beta" 'gamma delta' [Image 3] tail`,
          "gamma delta [Image 3] tail / alpha beta / gamma delta [Image 3] tail",
        ],
        ["[$1][$3]", "one two", "[one][]"],
        ["raw [$ARGUMENTS]", `"alpha beta" 'gamma delta'`, `raw ["alpha beta" 'gamma delta']`],
        ["  Review  ", " details ", "Review  \n\n details"],
        ["  Review  ", "  ", "Review"],
      ]) {
        expect(
          yield* invoke(new ConfigCommand.Info({ template }), {
            sessionID,
            prompt: { text, files },
            delivery: "queue",
          }),
        ).toBeUndefined()
        expect(prompts.at(-1)).toEqual({ sessionID, text: expected, files, delivery: "queue" })
      }
    }),
  )

  it.effect("switches agents before applying command or agent model defaults and admitting the prompt", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const ctx = promptHost(calls)
      const location = yield* Location.Service
      const reviewer = Agent.ID.make("reviewer")
      const agentModel = { id: Model.ID.make("agent-model"), providerID: Provider.ID.make("example") }
      const commandModel = {
        model: Model.ID.make("command-model"),
        providerID: Provider.ID.make("example"),
        variant: Model.VariantID.make("careful"),
      }
      const session = Session.Info.make({
        id: sessionID,
        projectID: location.project.id,
        agent: Agent.ID.make("build"),
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: location.directory },
      })
      for (const testCase of [
        {
          currentAgent: session.agent,
          agentModel,
          command: new ConfigCommand.Info({ template: "Review", agent: reviewer, model: commandModel }),
          expected: [
            ["session.get", { sessionID }],
            ["switchAgent", { sessionID, agent: reviewer }],
            ["agent.get", { agentID: reviewer }],
            ["switchModel", { sessionID, model: { id: "command-model", providerID: "example", variant: "careful" } }],
          ],
        },
        {
          currentAgent: reviewer,
          agentModel,
          command: new ConfigCommand.Info({ template: "Review", agent: reviewer }),
          expected: [
            ["session.get", { sessionID }],
            ["agent.get", { agentID: reviewer }],
            ["switchModel", { sessionID, model: agentModel }],
          ],
        },
        {
          currentAgent: session.agent,
          agentModel: undefined,
          command: new ConfigCommand.Info({ template: "Review", agent: reviewer }),
          expected: [
            ["session.get", { sessionID }],
            ["switchAgent", { sessionID, agent: reviewer }],
            ["agent.get", { agentID: reviewer }],
          ],
        },
        {
          currentAgent: session.agent,
          agentModel,
          command: new ConfigCommand.Info({
            template: "Review",
            model: { model: commandModel.model, providerID: commandModel.providerID },
          }),
          expected: [["switchModel", { sessionID, model: { id: "command-model", providerID: "example" } }]],
        },
      ]) {
        calls.length = 0
        const invoke = yield* CommandInvocation.make(
          host({
            agent: {
              ...ctx.agent,
              get: (input) =>
                Effect.sync(() => {
                  calls.push(["agent.get", input])
                  return { location, data: { ...Agent.Info.default(reviewer), model: testCase.agentModel } }
                }),
            },
            session: {
              ...ctx.session,
              get: (input) =>
                Effect.sync(() => {
                  calls.push(["session.get", input])
                  return { ...session, agent: testCase.currentAgent }
                }),
              switchAgent: (input) => Effect.sync(() => calls.push(["switchAgent", input])),
              switchModel: (input) => Effect.sync(() => calls.push(["switchModel", input])),
            },
          }),
        )
        yield* invoke(testCase.command, {
          sessionID,
          prompt: { text: "" },
          delivery: "steer",
        })
        expect(calls).toEqual([...testCase.expected, { sessionID, text: "Review", delivery: "steer" }])
      }
    }),
  )

  it.live("interpolates in source order using the location, closed stdin and nonzero-exit output", () =>
    Effect.gen(function* () {
      const prompts: unknown[] = []
      const location = yield* Location.Service
      yield* Effect.promise(() => Bun.write(path.join(location.directory, "context.txt"), "context"))
      const invoke = yield* CommandInvocation.make(promptHost(prompts))
      yield* invoke(
        new ConfigCommand.Info({
          template:
            'first=!`read value || printf closed-; cat context.txt; sleep 0.05; printf "%s" "-stderr" >&2; exit 7`; second=!`printf "%s" "$1"`',
        }),
        { sessionID, prompt: { text: "argument" }, delivery: "steer" },
      )
      expect(prompts).toEqual([{ sessionID, text: "first=closed-context-stderr; second=argument", delivery: "steer" }])
    }),
  )

  it.live("wraps process failures with the shell source and does not admit a prompt", () =>
    Effect.gen(function* () {
      const prompts: unknown[] = []
      const location = yield* Location.Service
      const missing = path.join(location.directory, "missing-shell")
      const invoke = yield* CommandInvocation.make(promptHost(prompts)).pipe(
        Effect.provideService(ShellSelect.Service, { ...shell, resolve: () => Effect.succeed(missing) }),
      )
      const error = yield* invoke(new ConfigCommand.Info({ template: '!`printf "hello"`' }), {
        sessionID,
        prompt: { text: "" },
        delivery: "steer",
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('Shell interpolation failed for "printf \\"hello\\"": Command failed:')
      expect(String(error)).toContain(missing)
      expect(prompts).toEqual([])
    }),
  )
})

function promptHost(prompts: unknown[]) {
  return host({
    session: {
      prompt: (input) =>
        Effect.sync(() => {
          prompts.push(input)
          return SessionInbox.User.make({
            id: SessionMessage.ID.make("msg_command_invocation"),
            sessionID: input.sessionID,
            timeCreated: DateTime.makeUnsafe(0),
            type: "user",
            payload: { text: input.text },
            delivery: input.delivery ?? "steer",
          })
        }),
    },
  })
}
