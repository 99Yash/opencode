import { describe, expect, test } from "bun:test"
import type { IntegrationInfo } from "@opencode-ai/client"
import {
  connectionSummary,
  connectMethods,
  credentialConnections,
  integrationOptions,
} from "../../../../src/component/dialog-integration"
import { wire, type Wire } from "../../../fixture/wire"

const integration = (value: Wire<Partial<IntegrationInfo> & Pick<IntegrationInfo, "id" | "name">>): IntegrationInfo =>
  wire<IntegrationInfo>({
    methods: [],
    connections: [],
    ...value,
  })

describe("integrationOptions", () => {
  test("keeps popular integrations first and sorts the rest alphabetically", () => {
    expect(
      integrationOptions([
        integration({ id: "mistral", name: "Mistral" }),
        integration({ id: "openai", name: "OpenAI" }),
        integration({ id: "custom-z", name: "Zebra" }),
        integration({ id: "anthropic", name: "Anthropic" }),
      ]).map((item) => item.id),
    ).toEqual(wire<IntegrationInfo["id"][]>(["openai", "anthropic", "mistral", "custom-z"]))
  })
})

describe("connectMethods", () => {
  test("offers key and OAuth methods but not environment discovery", () => {
    expect(
      connectMethods(
        integration({
          id: "example",
          name: "Example",
          methods: [
            { type: "env", names: ["EXAMPLE_KEY"] },
            { type: "key", label: "API key" },
            { type: "oauth", id: "account", label: "Account" },
          ],
        }),
      ).map((method) => method.type),
    ).toEqual(["oauth", "key"])
  })
})

describe("credentialConnections", () => {
  test("returns removable credential connections only", () => {
    expect(
      credentialConnections(
        integration({
          id: "example",
          name: "Example",
          connections: [
            { type: "env", name: "EXAMPLE_KEY" },
            { type: "credential", id: "cred_1", label: "Work" },
          ],
        }),
      ),
    ).toEqual(wire<ReturnType<typeof credentialConnections>>([{ type: "credential", id: "cred_1", label: "Work" }]))
  })
})

describe("connectionSummary", () => {
  test("shows credential labels and environment variables", () => {
    expect(
      connectionSummary(
        integration({
          id: "example",
          name: "Example",
          connections: [
            { type: "credential", id: "cred_1", label: "Work" },
            { type: "env", name: "EXAMPLE_KEY" },
          ],
        }),
      ),
    ).toBe("Work, $EXAMPLE_KEY")
  })
})
