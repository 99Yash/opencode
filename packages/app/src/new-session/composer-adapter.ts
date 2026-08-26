import { base64Encode } from "@opencode-ai/util/encode"
import { getDirectory } from "@opencode-ai/util/path"
import type { SessionMessageUser } from "@opencode-ai/client/promise"
import { startTransition } from "solid-js"
import type { NewSessionComposerAdapter } from "@/composer/adapter"
import { useComposerState } from "@/composer/persistence"
import { createComposerControls, createComposerModelSelection } from "@/composer/selection"
import { createComposerProjectControls } from "./project/controller"
import { useLanguage } from "@/runtime/i18n/language"
import { useLocal } from "@/providers/models/selection"
import { useData, useServer } from "@/runtime/server/current"
import { type ServerSDK, useServerSDK } from "@/runtime/server/client"
import { useTabs } from "@/shell/tabs/tabs"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useSessionKey } from "@/session/session-layout"
import { showToast } from "@/shell/notifications/toast"
import { SessionRouteKey, SessionStateKey } from "@/runtime/server/scope"
import { clearSessionMessageHandoff, setSessionMessageHandoff } from "@/session/handoff"
import { beginWorkspaceSetup } from "@/workspaces/setup"

export function createNewSessionComposerAdapter(props: {
  draftID: string
  worktree: () => string
  branch: () => string | undefined
  submitted: () => void
}) {
  const route = useSessionKey()
  const prompt = useComposerState()
  const state = prompt.capture()
  const local = useLocal()
  const data = useData()
  const server = useServer()
  const serverSDK = useServerSDK()
  const tabs = useTabs()
  const location = useWorkspaceLocation()
  const language = useLanguage()
  const model = createComposerModelSelection({ agent: () => local.agent.current() })
  const controls = createComposerControls({ sessionKey: route.sessionKey, model })

  const adapter: NewSessionComposerAdapter = {
    kind: "new-session",
    state,
    ready: prompt.ready,
    controls,
    working: () => false,
    submitted: props.submitted,
    async start(selection, submission) {
      const projectDirectory = location().directory
      const worktree = props.worktree()
      const workspace = await resolveSessionDirectory({
        projectDirectory,
        worktree,
        branch: props.branch(),
        data,
        serverSDK,
        language,
      })
      if (!workspace) return
      const sessionDirectory = workspace.directory

      const created = data.session.create({
        agent: selection.agent,
        model: {
          id: selection.model.modelID,
          providerID: selection.model.providerID,
          variant: selection.variant,
        },
        location: { directory: sessionDirectory },
      })
      const creation = created.request.then(
        () => ({ ok: true as const }),
        (error) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(language, error),
          })
          return { ok: false as const, error }
        },
      )
      const afterCreation = async <T>(run: () => Promise<T>) => {
        const result = await creation
        if (!result.ok) throw result.error
        return run()
      }
      const sessionKey = SessionStateKey.from(
        serverSDK.scope,
        SessionRouteKey.fromRoute(base64Encode(sessionDirectory), created.id),
      )
      if (workspace.initializing) beginWorkspaceSetup(created.id, workspace.ready)
      const cleanupReady = startTransition(() => {
        tabs.updateDraft(props.draftID, { worktree: undefined, branch: undefined })
        local.session.promote(sessionDirectory, created.id, {
          agent: selection.agent,
          model: selection.model,
          variant: selection.variant ?? null,
        })
        tabs.promoteDraft(props.draftID, { server: server.key, sessionId: created.id })
        submission.retarget(
          prompt.capture(
            { dir: base64Encode(sessionDirectory), id: created.id },
            { server: server.key, scope: serverSDK.scope },
          ),
        )
      })

      return {
        cleanupReady,
        session: {
          id: created.id,
          directory: sessionDirectory,
          handoff: createMessageHandoff(sessionKey, created.id, serverSDK.event),
          api: {
            command: (input) => afterCreation(() => serverSDK.api.session.command(input)),
            shell: (input) => afterCreation(() => serverSDK.api.session.shell(input)),
            switchAgent: (input) => afterCreation(() => serverSDK.api.session.switchAgent(input)),
            switchModel: (input) => afterCreation(() => serverSDK.api.session.switchModel(input)),
          },
          data: {
            location: data.location,
            session: {
              setStatus: data.session.setStatus,
              prompt: (input) =>
                data.session.prompt({
                  ...input,
                  gate: Promise.all([input.gate, afterCreation(async () => undefined), workspace.ready]),
                }),
            },
          },
          current: () => data.session.get(created.id),
          admitted: (messageID) =>
            data.session.input.has(created.id, messageID) || !!data.session.message.get(created.id, messageID),
        },
      }
    },
  }

  return {
    adapter,
    project: createComposerProjectControls({ draftId: props.draftID }),
    model,
    ready: prompt.ready,
  }
}

function createMessageHandoff(key: string, sessionID: string, event: ServerSDK["event"]) {
  let unsubscribe: VoidFunction | undefined
  return {
    set(message: SessionMessageUser) {
      unsubscribe?.()
      setSessionMessageHandoff(key, message)
      unsubscribe = event.on("session.inbox.enqueued", (item) => {
        if (item.data.sessionID !== sessionID || item.data.inboxID !== message.id) return
        unsubscribe?.()
        unsubscribe = undefined
        clearSessionMessageHandoff(key, message.id)
      })
    },
    clear(messageID: string) {
      unsubscribe?.()
      unsubscribe = undefined
      clearSessionMessageHandoff(key, messageID)
    },
  }
}

async function resolveSessionDirectory(input: {
  projectDirectory: string
  worktree: string
  branch?: string
  data: ReturnType<typeof useData>
  serverSDK: ReturnType<typeof useServerSDK>
  language: ReturnType<typeof useLanguage>
}) {
  if (input.worktree !== "create") {
    return {
      directory: input.worktree === "main" ? input.projectDirectory : input.worktree,
      ready: Promise.resolve(),
      initializing: false,
    }
  }

  const projectID = input.data.location.info({ directory: input.projectDirectory })?.project.id ?? ""
  const pending = Promise.withResolvers<
    { directory: string; ready: Promise<void>; initializing: boolean } | undefined
  >()
  const unsubscribe = input.serverSDK.event.on("worktree.updated", (event) => {
    if (event.data.projectID !== projectID || !event.data.directory) return
    unsubscribe()
    pending.resolve({ directory: event.data.directory, ready, initializing: true })
  })
  const creation = input.serverSDK.api.worktree
    .create({
      projectID,
      strategy: "git",
      branch: input.branch,
      directory: getDirectory(
        input.data.location.info({ directory: input.projectDirectory })?.project.directory ?? input.projectDirectory,
      ),
    })
    .then(
      (created) => ({ ok: true as const, created }),
      (error) => ({ ok: false as const, error }),
    )
  const ready = creation.then((result) => {
    unsubscribe()
    if (result.ok) {
      pending.resolve({ directory: result.created.directory, ready: Promise.resolve(), initializing: false })
      return
    }
    showToast({
      title: input.language.t("prompt.toast.worktreeCreateFailed.title"),
      description: errorMessage(input.language, result.error),
    })
    pending.resolve(undefined)
    throw result.error
  })
  void ready.catch(() => undefined)
  const workspace = await pending.promise
  if (!workspace) return
  await input.serverSDK.api.location.get({ location: { directory: workspace.directory } })
  return workspace
}

function errorMessage(language: ReturnType<typeof useLanguage>, error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  return language.t("common.requestFailed")
}
