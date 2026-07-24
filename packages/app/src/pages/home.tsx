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
          <HomeProjectsView
            language={projects.language}
            servers={projects.servers}
            projects={projects.projects}
            recentlyClosed={projects.recentlyClosed}
            selection={projects.selection}
            homedir={projects.homedir}
            serverHealth={projects.serverHealth}
            projectsForServer={projects.projectsForServer}
            collapsed={projects.collapsed}
            menuOpen={projects.menuOpen}
            canDefaultServer={projects.canDefaultServer}
            isDefaultServer={projects.isDefaultServer}
            canRevealProject={projects.canRevealProject}
            fileManagerActionLabel={projects.fileManagerActionLabel}
            unseenCount={projects.unseenCount}
            serverMenuID={projects.serverMenuID}
            projectMenuID={projects.projectMenuID}
            onWheel={sessions.scroll.containWheel}
            onChooseProject={projects.chooseProject}
            onFocusServer={projects.focusServer}
            onToggleCollapsed={projects.toggleCollapsed}
            onEditServer={projects.openEditServer}
            onSetDefaultServer={projects.setDefaultServer}
            onRemoveServer={projects.removeServer}
            onSetMenuOpen={projects.setMenuOpen}
            onMoveProject={projects.moveProject}
            onSelectProject={projects.selectProject}
            onAddProjects={projects.addProjects}
            onOpenProjectNewSession={projects.openProjectNewSession}
            onEditProject={projects.editProject}
            onRevealProject={projects.revealProject}
            onClearNotifications={projects.clearNotifications}
            onCloseProject={projects.closeProject}
            onOpenSettings={projects.openSettings}
            onOpenHelp={projects.openHelp}
          />
          <HomeSessionsView
            language={sessions.language}
            groups={sessions.groups}
            loading={sessions.loading}
            showProjectName={sessions.showProjectName}
            server={sessions.server}
            canCreateSession={sessions.canCreateSession}
            searchValue={sessions.search.value}
            searchPlaceholder={sessions.search.placeholder}
            searchOpen={sessions.search.open}
            searchLoading={sessions.search.loading}
            searchResults={sessions.search.results}
            searchActive={sessions.search.active}
            searchNoResultsLabel={sessions.search.noResultsLabel}
            titleOpacity={sessions.header.titleOpacity}
            isOpenTab={sessions.hasOpenTab}
            onCreateSession={sessions.createSession}
            onOpenSession={sessions.openSession}
            onArchiveSession={sessions.archiveSession}
            onSetHoverTarget={sessions.scroll.setHoverTarget}
            onSetThumbTrack={sessions.scroll.setThumbTrack}
            onSetContent={sessions.header.setContent}
            onSetHeader={sessions.header.setHeader}
            onWheel={sessions.scroll.containWheel}
            onSetSearchRoot={sessions.search.setRoot}
            onSetSearchInput={sessions.search.setInput}
            onSetSearchList={sessions.search.setList}
            onSearchFocus={sessions.search.focus}
            onSearchInput={sessions.search.input}
            onSearchClose={sessions.search.close}
            onSearchMove={sessions.search.move}
            onSearchSelectActive={sessions.search.selectActive}
            onSearchHighlight={sessions.search.highlight}
            onSearchSelect={sessions.search.select}
          />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.openSettings}
            onOpenHelp={projects.openHelp}
            language={projects.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
