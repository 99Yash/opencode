import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Location } from "../src/location.js"

const details = {
  directory: "/project",
  project: { id: "project", directory: "/project", canonical: "/project" },
  home: "/home/user",
}

test("Location.Details includes the server home directory", () => {
  expect(Schema.decodeUnknownSync(Location.Details)(details).home).toBe("/home/user")
  expect(() => Schema.decodeUnknownSync(Location.Details)({ ...details, home: undefined })).toThrow()
})
