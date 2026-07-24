import { type ComponentProps, createMemo, For, Show } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { shouldOpenSessionInBackground } from "../home-session-open"
import {
  HomeSessionStatusController,
  homeSessionSearchKey,
  type HomeSessionRecord,
  type HomeSessionsController,
} from "./home-sessions-controller"

const SHOW_HOME_SESSION_ARCHIVE = false
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
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

export function HomeSessionsView(props: { controller: HomeSessionsController }) {
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
            style={{ top: "-6px", left: "-6px", width: "calc(100% + 12px)" }}
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
