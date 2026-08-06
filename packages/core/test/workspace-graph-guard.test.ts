import { describe, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { hostedReplacements, locationServices } from "@opencode-ai/core/location-services"
import { Workspace } from "@opencode-ai/core/workspace"
import { Node } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { AppProcess } from "@opencode-ai/util/process"
import { FSUtil } from "@opencode-ai/util/fs-util"

// Location-scoped services receive Location-relative and Location-absolute
// paths from tools. In a hosted graph those are provider paths (for example
// /workspace/src), so any Location-scoped service that still depends on a
// host primitive would silently run provider paths against the host machine.
// This is the guardrail for the class of bug where the read tool's filesystem
// stayed host-backed after the hosted rollout.
//
// Every entry here is a documented decision, not an exemption by default.
// Adding a new Location-scoped service that touches FSUtil or AppProcess
// fails this test until the service either gets a hosted replacement in
// hostedReplacements or is justified below.
const allowed: Record<string, string> = {
  // Host-side by design: hosted graphs read only global (host) configuration.
  "@opencode/Config": "global host config sources only (Config.configured({ project: false }))",
  "@opencode/InstructionDiscovery": "global host instructions only (configured({ project: false }))",
  "@opencode/Skill": "skills load from host config directories",
  "@opencode/PluginSupervisor": "plugins are host processes loaded from host paths",
  "@opencode/Integration": "integrations run host-side CLIs",
  "@opencode/ProjectCopy": "project copy refresh operates on host-owned global project data",
  // Known gaps: these never advertise hosted capability, but their services
  // still exist in hosted graphs and would touch host paths if invoked with
  // provider paths. Each needs an environment-backed design or an explicit
  // hosted no-op before workspaces ship publicly.
  "@opencode/Command": "TODO: `!command` template substitution would run on the host",
  "@opencode/LocationWatcher": "TODO: watches the provider directory path on the host filesystem",
  "@opencode/Snapshot": "TODO: hosted snapshots need environment-backed git",
  "@opencode/Vcs": "TODO: hosted VCS info is stated by Project.hostedGlobal, service methods remain host git",
  "@opencode/v2/Formatter": "TODO: formatters are host binaries; hosted FileMutation deliberately omits format",
  "session-instructions": "TODO: per-session instruction file loads read the host filesystem",
}

describe("hosted location graph", () => {
  test("location-scoped services do not use host primitives without justification", () => {
    const ref = Location.Ref.make({
      directory: AbsolutePath.make("/workspace"),
      workspaceID: Workspace.ID.make("wrk_graphguard000000000000000"),
    })
    // Replacement targets may be bare layers in general; every hosted
    // replacement is a node today, and bare-layer targets have no walkable
    // dependencies anyway.
    const replaced = new Map<LayerNode.Node<unknown, unknown, any>, LayerNode.Node<unknown, unknown, any>>(
      hostedReplacements(ref, ref.workspaceID!).flatMap(([from, to]) =>
        "dependencies" in to ? [[from, to] as const] : [],
      ),
    )
    const resolve = (node: LayerNode.Node<unknown, unknown, any>) => replaced.get(node) ?? node

    const hostPrimitives = new Set<LayerNode.Node<unknown, unknown, any>>([FSUtil.node, AppProcess.node])
    const visited = new Set<LayerNode.Node<unknown, unknown, any>>()
    const offenders = new Map<string, string[]>()
    const queue: LayerNode.Node<unknown, unknown, any>[] = [locationServices]
    while (queue.length > 0) {
      const node = resolve(queue.pop()!)
      if (visited.has(node)) continue
      visited.add(node)
      for (const dependency of node.dependencies) {
        const target = resolve(dependency)
        if (hostPrimitives.has(target) && node.tag === Node.tags.values.location) {
          offenders.set(node.name, [...(offenders.get(node.name) ?? []), target.name])
        }
        queue.push(target)
      }
    }

    const unjustified = [...offenders.entries()]
      .filter(([name]) => !(name in allowed))
      .map(([name, primitives]) => `${name} -> ${primitives.join(", ")}`)
      .sort()
    expect(unjustified).toEqual([])

    // Stale allowlist entries must be removed so the inventory stays honest.
    const stale = Object.keys(allowed).filter((name) => !offenders.has(name))
    expect(stale).toEqual([])
  })
})
