import type { PackageResolver } from "../../src/plugin/context"

export const noPackages: PackageResolver = {
  resolve: async () => undefined,
  check: async () => ({ mutable: false }),
  update: async () => {
    throw new Error("No fixture package to update")
  },
  reload: async () => {
    throw new Error("No fixture package to reload")
  },
}
