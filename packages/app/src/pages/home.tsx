import { type ComponentProps, createMemo, For, Show } from "solid-js"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { getProjectAvatarVariant, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useLanguage } from "@/context/language"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { ServerRowMenuView, serverMenuLabels } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { type ServerHealth } from "@/utils/server-health"
import { shouldOpenSessionInBackground } from "./home-session-open"
import { createHomeProjectsController, type HomeProjectsController } from "./home/home-projects-controller"
import {
  createHomeSessionsController,
  HomeSessionStatusController,
  homeSessionSearchKey,
  type HomeSessionRecord,
  type HomeSessionsController,
} from "./home/home-sessions-controller"

const SHOW_HOME_SESSION_ARCHIVE = false
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-7 gap-2 px-1.5 [font-weight:440] text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base hover:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base data-[selected]:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:hover:bg-v2-background-bg-layer-03 focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"
const HOME_SEARCH_RESULT_ROW =
  "flex h-10 w-full shrink-0 cursor-default items-center gap-2 border-0 py-3 pl-[18px] pr-6 text-left transition-[background-color] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_SEARCH_RESULT_TITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-base [font-weight:530]"
const HOME_SEARCH_RESULT_META =
  "min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]"

// Middle-click or Cmd+click on macOS (Ctrl+click elsewhere) opens a session
// tab in the background without navigating, matching browser conventions.
function isBackgroundOpen(event: MouseEvent) {
  return shouldOpenSessionInBackground({
    button: event.button,
    mac: typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

export function NewHome() {
  const projects = createHomeProjectsController()
  const sessions = createHomeSessionsController(projects)
  return (
    <div class="rounded-[10px] shadow-[var(--v2-elevation-raised)] m-2 min-h-0 overflow-hidden bg-v2-background-bg-base self-stretch flex-1">
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={sessions.scroll.thumbTrack}
        thumbHoverTarget={sessions.scroll.hoverTarget}
        viewportRef={sessions.scroll.setViewport}
        onScroll={(event) => sessions.scroll.update(event.currentTarget.scrollTop)}
        onWheel={sessions.scroll.containOuterWheel}
      >
        <div class="mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3 lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6">
          <HomeProjectColumn controller={projects} onWheel={sessions.scroll.containWheel} />
          <HomeSessionsView controller={sessions} />
          <HomeUtilityNav
            class="flex lg:hidden"
            openSettings={projects.openSettings}
            openHelp={projects.openHelp}
            language={projects.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}

function HomeSessionsView(props: { controller: HomeSessionsController }) {
  return (
    <section
      ref={props.controller.scroll.setHoverTarget}
      class="min-h-0 min-w-0 flex-1 flex flex-col"
      aria-label={props.controller.language.t("sidebar.project.recentSessions")}
    >
      <div
        class="sticky top-0 z-30 shrink-0 bg-v2-background-bg-base pb-3 pt-6 lg:pt-12"
        onWheel={props.controller.scroll.containWheel}
      >
        <HomeSessionSearch controller={props.controller} />
        <Show when={props.controller.groups().length > 0 && props.controller.canCreateSession()}>
          <div class="pointer-events-none absolute right-0 top-[84px] z-20 flex lg:top-[108px]">
            <ButtonV2
              data-action="home-new-session"
              variant="ghost-muted"
              size="normal"
              icon="edit"
              class="pointer-events-auto h-7 px-2 [font-weight:530]"
              onClick={props.controller.createSession}
            >
              {props.controller.language.t("command.session.new")}
            </ButtonV2>
          </div>
        </Show>
      </div>
      <div class="pointer-events-none sticky top-[84px] z-40 h-0 -mr-3 lg:top-[108px]">
        <div
          ref={props.controller.scroll.setThumbTrack}
          data-component="home-session-scroll-track"
          class="relative ml-auto h-[calc(100cqh-84px)] w-3 lg:h-[calc(100cqh-108px)]"
        />
      </div>
      <div class="-mr-3 min-h-[calc(100cqh-72px)] lg:min-h-[calc(100cqh-96px)]">
        <Show
          when={!props.controller.loading()}
          fallback={
            <div class="pt-3">
              <HomeSessionSkeleton label={props.controller.language.t("common.loading")} />
            </div>
          }
        >
          <Show
            when={props.controller.groups().length > 0}
            fallback={
              <HomeSessionsEmpty
                onNewSession={props.controller.canCreateSession() ? props.controller.createSession : undefined}
                language={props.controller.language}
              />
            }
          >
            <div ref={props.controller.header.setContent} class="flex flex-col pt-3 pr-3 pb-16">
              <For each={props.controller.groups()}>
                {(group, index) => (
                  <>
                    <HomeSessionGroupHeader
                      title={group.title}
                      titleOpacity={props.controller.header.titleOpacity(group.id)}
                      ref={(element) => props.controller.header.setHeader(group.id, element)}
                      elevated={index() === 0}
                    />
                    <div
                      class={`flex min-w-0 flex-col gap-px pt-4 ${index() === props.controller.groups().length - 1 ? "" : "mb-6"}`}
                    >
                      <For each={group.sessions}>
                        {(record) => <HomeSessionRow controller={props.controller} record={record} />}
                      </For>
                    </div>
                  </>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function HomeProjectColumn(props: { controller: HomeProjectsController; onWheel: (event: WheelEvent) => void }) {
  return (
    <aside
      class="mt-6 flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden lg:sticky lg:top-14 lg:mt-14 lg:h-[calc(100cqh-56px)] lg:self-start lg:pt-[52px]"
      aria-label={props.controller.language.t("home.projects")}
      onWheel={(event) => {
        if (event.target === event.currentTarget) return
        props.onWheel(event)
      }}
    >
      <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-3">
        <div class="text-v2-text-text-muted [font-weight:530]">{props.controller.language.t("home.projects")}</div>
        <Show
          when={
            props.controller.servers().length === 1 &&
            !(props.controller.projects().length === 0 && props.controller.recentlyClosed().length > 0)
          }
        >
          <TooltipV2 placement="bottom" value={props.controller.language.t("home.project.add")}>
            <IconButtonV2
              data-action="home-add-project"
              variant="ghost-muted"
              size="large"
              class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
              icon={<IconV2 name="folder-add-left" />}
              disabled={props.controller.serverHealth(props.controller.servers()[0])?.healthy === false}
              onClick={() => props.controller.chooseProject(props.controller.servers()[0])}
              aria-label={props.controller.language.t("home.project.add")}
            />
          </TooltipV2>
        </Show>
      </div>
      <ScrollView data-slot="home-projects-scroll" class="min-h-0 min-w-0 shrink">
        <Show
          when={props.controller.servers().length > 1}
          fallback={
            <div class="pr-3">
              <Show
                when={props.controller.projects().length > 0}
                fallback={
                  <HomeProjectEmpty
                    controller={props.controller}
                    server={props.controller.servers()[0]}
                    recentlyClosed={props.controller.recentlyClosed()}
                  />
                }
              >
                <HomeProjectList
                  controller={props.controller}
                  server={props.controller.servers()[0]}
                  projects={props.controller.projects()}
                />
              </Show>
            </div>
          }
        >
          <div class="flex min-w-0 flex-col gap-4 pr-3">
            <For each={props.controller.servers()}>
              {(item) => {
                const projects = () => props.controller.projectsForServer(item)
                const healthy = () => !!props.controller.serverHealth(item)?.healthy
                const hasProjects = () => projects().length > 0
                const collapsed = () => props.controller.collapsed(item)
                return (
                  <div class="flex min-w-0 flex-col gap-1">
                    <HomeServerRow
                      server={item}
                      controller={props.controller}
                      selected={
                        props.controller.selection().server === ServerConnection.key(item) &&
                        !props.controller.selection().directory
                      }
                      collapsed={collapsed()}
                      health={props.controller.serverHealth(item)}
                    />
                    <Show when={healthy() && hasProjects() && !collapsed()}>
                      <div class="mx-3 h-px bg-v2-border-border-base" />
                      <HomeProjectList controller={props.controller} server={item} projects={projects()} />
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </ScrollView>
      <HomeUtilityNav
        class="mb-8 mt-4 hidden shrink-0 lg:flex"
        openSettings={props.controller.openSettings}
        openHelp={props.controller.openHelp}
        language={props.controller.language}
      />
    </aside>
  )
}

function HomeUtilityNav(props: {
  class?: string
  openSettings: () => void
  openHelp: () => void
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <div class={`${props.class ?? ""} min-w-0 flex-col gap-1 pr-3`}>
      <button
        type="button"
        class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
        onClick={props.openSettings}
      >
        <IconV2 name="settings-gear" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.settings")}</span>
      </button>
      <button
        type="button"
        class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
        onClick={props.openHelp}
      >
        <IconV2 name="help" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.help")}</span>
      </button>
    </div>
  )
}

function HomeServerRow(props: {
  controller: HomeProjectsController
  server: ServerConnection.Any
  selected: boolean
  collapsed: boolean
  health: ServerHealth | undefined
}) {
  const healthy = () => !!props.health?.healthy
  const canToggle = () => healthy() && props.controller.projectsForServer(props.server).length > 0
  const menuID = () => props.controller.serverMenuID(props.server)
  return (
    <div class="group/server relative flex h-7 min-w-0 items-center rounded-[6px]">
      <button
        type="button"
        class={`${HOME_PROJECT_NAV_ROW} pr-16 disabled:opacity-60`}
        data-selected={props.selected ? "" : undefined}
        disabled={!healthy()}
        onClick={() => props.controller.focusServer(props.server)}
      >
        <span
          data-action="home-server-collapse"
          class="inline-flex -ml-0.5 -mr-1.5 size-5 shrink-0 items-center justify-center rounded-[4px] text-v2-icon-icon-muted"
          classList={{
            "hover:bg-v2-overlay-simple-overlay-hover": canToggle(),
            "cursor-default opacity-40": !canToggle(),
          }}
          aria-label={
            props.collapsed
              ? props.controller.language.t("home.server.expand")
              : props.controller.language.t("home.server.collapse")
          }
          aria-disabled={!canToggle()}
          aria-expanded={canToggle() ? !props.collapsed : undefined}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (!canToggle()) return
            props.controller.toggleCollapsed(props.server)
          }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <IconV2
            name="chevron-down"
            size="small"
            class="transition-transform duration-150 ease-in-out"
            style={{ transform: `rotate(${props.collapsed ? -90 : 0}deg)` }}
          />
        </span>
        <div class="flex size-4 shrink-0 items-center justify-center -mr-0.5">
          <ServerHealthIndicator health={props.health} />
        </div>
        <span class="flex min-w-0 items-center gap-1">
          <span class={HOME_PROJECT_NAV_LABEL}>{props.server.displayName ?? new URL(props.server.http.url).host}</span>
          <Show when={props.server.label}>
            {(label) => (
              <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                {label()}
              </span>
            )}
          </Show>
        </span>
      </button>
      <div
        class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/server:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={props.controller.menuOpen(menuID())}
      >
        <ServerRowMenuView
          server={props.server}
          labels={serverMenuLabels(props.controller.language)}
          canDefault={props.controller.canDefaultServer()}
          isDefault={props.controller.isDefaultServer(props.server)}
          onEdit={props.controller.openEditServer}
          onSetDefault={() => props.controller.setDefaultServer(props.server)}
          onRemoveDefault={() => props.controller.setDefaultServer(undefined)}
          onRemove={() => props.controller.removeServer(props.server)}
          open={props.controller.menuOpen(menuID())}
          onOpenChange={(open) => props.controller.setMenuOpen(menuID(), open)}
        />
        <TooltipV2
          class="flex shrink-0 items-center"
          placement="bottom"
          value={props.controller.language.t("home.project.add")}
        >
          <IconButtonV2
            data-action="home-add-project"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="folder-add-left" />}
            aria-label={props.controller.language.t("home.project.add")}
            disabled={props.health?.healthy === false}
            onClick={() => props.controller.chooseProject(props.server)}
          />
        </TooltipV2>
      </div>
    </div>
  )
}

type HomeProjectListProps = {
  controller: HomeProjectsController
  server: ServerConnection.Any
  projects: LocalProject[]
}

function HomeProjectList(props: HomeProjectListProps) {
  let listRef!: HTMLDivElement

  return (
    <DragDropProvider
      sensors={(defaults) => [
        ...defaults.filter((sensor) => sensor !== PointerSensor),
        PointerSensor.configure({
          activationConstraints: (event) =>
            event.pointerType === "touch"
              ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
              : [new PointerActivationConstraints.Distance({ value: 4 })],
          preventActivation: (event) => event.target instanceof Element && !!event.target.closest("[data-action]"),
        }),
      ]}
      modifiers={[RestrictToVerticalAxis, RestrictToElement.configure({ element: () => listRef })]}
      plugins={(defaults) => [
        ...defaults.filter((plugin) => plugin !== AutoScroller && plugin !== Feedback),
        AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.05 } }),
        Feedback.configure({ dropAnimation: null }),
      ]}
      onDragEnd={(event) => {
        const source = event.operation.source
        if (event.canceled || !isSortable(source)) return
        if (source.initialIndex !== source.index)
          props.controller.moveProject(props.server, source.id.toString(), source.index)
        if (props.controller.selection().server !== ServerConnection.key(props.server))
          props.controller.selectProject(props.server, source.id.toString())
      }}
    >
      <div class="flex min-w-0 flex-col gap-1" ref={listRef}>
        {/* Keyed on worktree strings: the enriched project objects are
            recreated on every store or sync update, so iterating them directly
            remounts all rows — killing any in-flight drag activation (the
            row's sortable unregisters on unmount) and discarding animations.
            String keys keep row elements alive and move them on reorder. */}
        <For each={props.projects.map((project) => project.worktree)}>
          {(worktree, index) => <HomeProjectSlot {...props} worktree={worktree} index={index} />}
        </For>
      </div>
    </DragDropProvider>
  )
}

function HomeProjectSlot(
  props: HomeProjectListProps & {
    worktree: string
    index: () => number
  },
) {
  const project = createMemo(() => props.projects.find((item) => item.worktree === props.worktree))

  return (
    <Show when={project()}>
      {(item) => (
        <HomeProjectRow
          controller={props.controller}
          project={item()}
          server={props.server}
          index={props.index}
          serverSelected={props.controller.selection().server === ServerConnection.key(props.server)}
          selected={
            props.controller.selection().server === ServerConnection.key(props.server) &&
            props.controller.selection().directory === props.worktree
          }
          unseenCount={props.controller.unseenCount(props.server, item())}
        />
      )}
    </Show>
  )
}

function HomeProjectEmpty(props: {
  controller: HomeProjectsController
  server: ServerConnection.Any
  recentlyClosed: LocalProject[]
}) {
  const unreachable = () => props.controller.serverHealth(props.server)?.healthy === false
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        data-action="home-add-project-row"
        class={`${HOME_PROJECT_NAV_ROW} disabled:opacity-60 [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
        disabled={unreachable()}
        onClick={() => props.controller.chooseProject(props.server)}
      >
        <IconV2 name="folder-add-left" size="small" />
        <span class={HOME_PROJECT_NAV_LABEL}>{props.controller.language.t("home.project.add")}</span>
      </button>
      <Show when={props.recentlyClosed.length > 0}>
        <div class="mt-3 flex h-7 min-w-0 shrink-0 items-center pl-1.5 pr-3">
          <div class="text-v2-text-text-faint [font-weight:530]">
            {props.controller.language.t("home.recentlyClosed")}
          </div>
        </div>
        <For each={props.recentlyClosed}>
          {(project) => <HomeRecentlyClosedRow project={project} controller={props.controller} server={props.server} />}
        </For>
      </Show>
    </div>
  )
}

function HomeRecentlyClosedRow(props: {
  controller: HomeProjectsController
  project: LocalProject
  server: ServerConnection.Any
}) {
  const unreachable = () => props.controller.serverHealth(props.server)?.healthy === false
  const path = () => {
    const home = props.controller.homedir()
    const worktree = props.project.worktree
    if (home && (worktree === home || worktree.startsWith(`${home}/`))) return `~${worktree.slice(home.length)}`
    return worktree
  }
  return (
    <TooltipV2 placement="right" value={path()}>
      <button
        type="button"
        data-component="home-recently-closed-row"
        class={`${HOME_PROJECT_NAV_ROW} disabled:opacity-60`}
        disabled={unreachable()}
        onClick={() => props.controller.addProjects(props.server, [props.project.worktree])}
      >
        <HomeProjectAvatar project={props.project} outline />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </button>
    </TooltipV2>
  )
}

function HomeProjectRow(props: {
  controller: HomeProjectsController
  project: LocalProject
  server: ServerConnection.Any
  index: () => number
  serverSelected: boolean
  selected: boolean
  unseenCount: number
}) {
  const serverUnreachable = () => props.controller.serverHealth(props.server)?.healthy === false
  const sortable = useSortable({
    get id() {
      return props.project.worktree
    },
    get index() {
      return props.index()
    },
  })
  let pointerDownSelected: boolean | undefined
  const menuID = () => props.controller.projectMenuID(props.server, props.project.worktree)
  return (
    <div
      ref={sortable.ref}
      class="group/project relative flex h-7 min-w-0 items-center rounded-[6px]"
      classList={{ "z-10": sortable.isDragSource() }}
    >
      <button
        type="button"
        data-component="home-project-row"
        class={`${HOME_PROJECT_NAV_ROW} pr-16 disabled:opacity-60`}
        classList={{
          "bg-v2-background-bg-layer-01 text-v2-text-text-base [box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]":
            sortable.isDragSource(),
        }}
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        disabled={serverUnreachable()}
        onPointerDown={(event) => {
          // Same-server mouse selection happens on pointerdown (like tabs),
          // but only ever selects; selectProject toggles, and deselecting here
          // would fire on every drag before the threshold is met. Cross-server
          // selection waits for click so reordering a remote server's projects
          // does not focus that server and load its session index. Touch is
          // excluded so flick-scrolling the list cannot select rows.
          pointerDownSelected = undefined
          if (event.button !== 0 || event.pointerType === "touch") return
          if (!props.serverSelected) return
          pointerDownSelected = props.selected
          if (!props.selected) props.controller.selectProject(props.server, props.project.worktree)
        }}
        onClick={(event) => {
          // The drag sensor calls preventDefault on post-drag clicks; never
          // toggle selection as part of a reorder.
          if (event.defaultPrevented) return
          // Keyboard activation and touch taps keep the original toggle.
          if (event.detail === 0 || pointerDownSelected === undefined) {
            props.controller.selectProject(props.server, props.project.worktree)
            return
          }
          // Mouse: pointerdown already selected unselected rows; a plain click
          // on an already-selected row toggles it off.
          if (pointerDownSelected) props.controller.selectProject(props.server, props.project.worktree)
          pointerDownSelected = undefined
        }}
      >
        <HomeProjectAvatar project={props.project} />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </button>
      <div
        class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={props.controller.menuOpen(menuID())}
      >
        <MenuV2
          gutter={6}
          modal={false}
          placement="bottom-end"
          open={props.controller.menuOpen(menuID())}
          onOpenChange={(open) => props.controller.setMenuOpen(menuID(), open)}
        >
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-project-menu"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.controller.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item
                onSelect={() => props.controller.openProjectNewSession(props.server, props.project.worktree)}
              >
                {props.controller.language.t("command.session.new")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => props.controller.editProject(props.server, props.project)}>
                {props.controller.language.t("dialog.project.edit.title")}
              </MenuV2.Item>
              <Show when={props.controller.canRevealProject(props.server)}>
                <MenuV2.Item onSelect={() => props.controller.revealProject(props.server, props.project)}>
                  {props.controller.fileManagerActionLabel()}
                </MenuV2.Item>
              </Show>
              <MenuV2.Item
                disabled={props.unseenCount === 0}
                onSelect={() => props.controller.clearNotifications(props.server, props.project)}
              >
                {props.controller.language.t("sidebar.project.clearNotifications")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => props.controller.closeProject(props.server, props.project.worktree)}>
                {props.controller.language.t("common.close")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <IconButtonV2
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="edit" />}
          aria-label={props.controller.language.t("command.session.new")}
          onClick={() => props.controller.openProjectNewSession(props.server, props.project.worktree)}
        />
      </div>
    </div>
  )
}

function HomeProjectAvatar(props: { project: LocalProject; outline?: boolean }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={props.outline ? undefined : getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={props.outline ? "outline" : getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}

function HomeSessionLeadingController(props: {
  controller: HomeSessionsController
  record: HomeSessionRecord
  revealProjectOnHover: boolean
}) {
  return (
    <HomeSessionStatusController
      controller={props.controller}
      record={props.record}
      render={(state) => (
        <HomeSessionLeading
          record={props.record}
          revealProjectOnHover={props.revealProjectOnHover}
          open={state.open()}
          unread={state.unread()}
          loading={state.loading()}
        />
      )}
    />
  )
}

function HomeSessionLeading(props: {
  record: HomeSessionRecord
  revealProjectOnHover: boolean
  open: boolean
  unread: boolean
  loading: boolean
}) {
  return (
    <div class="relative shrink-0">
      <Show when={props.open}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
          style={{ right: "calc(100% + 4px)" }}
        />
      </Show>
      <SessionTabAvatarView
        project={props.record.project}
        directory={props.record.session.directory}
        revealProjectOnHover={props.revealProjectOnHover}
        unread={props.unread}
        loading={props.loading}
      />
    </div>
  )
}

function HomeSessionSearch(props: { controller: HomeSessionsController }) {
  return (
    <div class="w-full">
      <div ref={props.controller.search.setRoot} data-component="home-session-search" class="relative z-30 w-full">
        <Show when={props.controller.search.open()}>
          <div
            data-component="home-session-search-panel"
            class="absolute flex flex-col overflow-hidden rounded-[12px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
            style={{
              top: "-6px",
              left: "-6px",
              width: "calc(100% + 12px)",
            }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-4 pt-4">
                <Show
                  when={!props.controller.search.loading()}
                  fallback={
                    <div class="flex items-center justify-center px-4 py-3 text-v2-text-text-muted [font-weight:440]">
                      <Spinner class="size-4" />
                    </div>
                  }
                >
                  <Show
                    when={props.controller.search.results().length > 0}
                    fallback={
                      <p class="my-1.5 px-4 pb-2 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {props.controller.search.noResultsLabel()}
                      </p>
                    }
                  >
                    <div class="flex flex-col">
                      <p class="my-1.5 pl-[18px] pr-6 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {props.controller.language.t("home.sessions.search.sessions")}
                      </p>
                      <ScrollView class="max-h-80" viewportRef={props.controller.search.setList}>
                        <div class="flex flex-col gap-px pb-2">
                          <For each={props.controller.search.results()}>
                            {(record) => (
                              <HomeSessionSearchResultRow
                                controller={props.controller}
                                record={record}
                                selected={props.controller.search.active() === homeSessionSearchKey(record)}
                              />
                            )}
                          </For>
                        </div>
                      </ScrollView>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label class="relative z-20 flex h-9 w-full items-center gap-2 rounded-[6px] bg-v2-background-bg-layer-02/60 py-1 pl-3 pr-2 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-02 focus-within:bg-v2-background-bg-layer-02">
          <IconV2 name="magnifying-glass" />
          <input
            ref={props.controller.search.setInput}
            class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
            value={props.controller.search.value()}
            placeholder={props.controller.search.placeholder()}
            aria-label={props.controller.search.placeholder()}
            aria-expanded={props.controller.search.open()}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              props.controller.search.active() && props.controller.search.open()
                ? `home-session-search-option-${props.controller.search.active()}`
                : undefined
            }
            onFocus={props.controller.search.focus}
            onInput={(event) => props.controller.search.input(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.controller.search.close()
                event.currentTarget.blur()
                return
              }
              if (!props.controller.search.open() || props.controller.search.results().length === 0) return
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                props.controller.search.move(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                props.controller.search.move(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                props.controller.search.selectActive()
              }
            }}
          />
          <Show when={props.controller.search.value()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={props.controller.search.placeholder()}
              onClick={() => {
                props.controller.search.close()
                props.controller.search.focus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchResultRow(props: {
  controller: HomeSessionsController
  record: HomeSessionRecord
  selected: boolean
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.controller.showProjectName() && props.record.projectName

  const key = () => homeSessionSearchKey(props.record)

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      role="option"
      aria-selected={props.selected}
      classList={{
        [HOME_SEARCH_RESULT_ROW]: true,
        "bg-v2-overlay-simple-overlay-hover": props.selected,
        group: !!showProjectName(),
      }}
      onMouseEnter={() => props.controller.search.highlight(props.record)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.controller.search.select(props.record, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.controller.search.select(props.record, { background: true })
      }}
    >
      <HomeSessionLeadingController
        controller={props.controller}
        record={props.record}
        revealProjectOnHover={!!showProjectName()}
      />
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          class={`${HOME_SEARCH_RESULT_TITLE} ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class={HOME_SEARCH_RESULT_META}>{props.record.projectName}</span>
        </Show>
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: {
  title: string
  titleOpacity: number
  ref: ComponentProps<"div">["ref"]
  elevated?: boolean
}) {
  return (
    <div
      ref={props.ref}
      class={`pointer-events-none sticky top-[84px] lg:top-[108px] flex h-7 min-w-0 items-center justify-between pl-3 bg-v2-background-bg-base ${props.elevated ? "home-session-group-header z-[5]" : "z-10"}`}
    >
      <div class={HOME_SECTION_LABEL} style={{ opacity: props.titleOpacity }}>
        {props.title}
      </div>
    </div>
  )
}

function HomeSessionRow(props: { controller: HomeSessionsController; record: HomeSessionRecord }) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const showProjectName = () => props.controller.showProjectName() && props.record.projectName

  return (
    <div
      class="group/session relative flex h-10 min-w-0 items-center rounded-[6px]"
      classList={{ group: !!showProjectName() }}
    >
      <button
        type="button"
        data-component="home-session-row"
        class={`${HOME_ROW} h-10 min-w-0 flex-1 gap-2 py-3 pl-3 pr-10`}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onClick={(event) => props.controller.openSession(props.record.session, { background: isBackgroundOpen(event) })}
        onAuxClick={(event) => {
          if (!isBackgroundOpen(event)) return
          event.preventDefault()
          props.controller.openSession(props.record.session, { background: true })
        }}
      >
        <HomeSessionLeadingController
          controller={props.controller}
          record={props.record}
          revealProjectOnHover={!!showProjectName()}
        />
        <span
          class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={showProjectName()}>
          <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
            {props.record.projectName}
          </span>
        </Show>
      </button>
      <Show when={SHOW_HOME_SESSION_ARCHIVE}>
        <div class="hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1 group-hover/session:opacity-100 focus-within:opacity-100">
          <TooltipV2
            class="flex shrink-0 items-center"
            placement="bottom"
            value={props.controller.language.t("common.archive")}
          >
            <IconButtonV2
              data-action="home-session-archive"
              variant="ghost-muted"
              size="large"
              icon={<IconV2 name="archive" />}
              aria-label={props.controller.language.t("common.archive")}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void props.controller.archiveSession(props.record.session)
              }}
            />
          </TooltipV2>
        </div>
      </Show>
    </div>
  )
}

function HomeSessionsEmpty(props: { onNewSession?: () => void; language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex min-h-full flex-col items-center gap-4 px-6 pt-[52px] text-center">
      <div class="shrink-0 text-[13px] leading-[13px] tracking-[-0.04px] text-v2-text-text-base [font-weight:530]">
        {props.language.t("home.sessions.empty")}
      </div>
      <p class="mb-1 text-center text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
        {props.language.t("home.sessions.empty.description")}
      </p>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2 data-action="home-new-session" variant="neutral" size="normal" icon="edit" onClick={onNewSession()}>
            {props.language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}
