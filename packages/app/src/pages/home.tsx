import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeProjectsView, HomeUtilityNav } from "./home/home-projects-view"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessionsView } from "./home/home-sessions-view"

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
          <HomeProjectsView controller={projects} onWheel={sessions.scroll.containWheel} />
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
