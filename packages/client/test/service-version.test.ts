import { expect, test } from "bun:test"
import { isServiceVersionCompatible } from "../src/service"

test("accepts the same or a newer service version", () => {
  expect(isServiceVersionCompatible("0.0.0-next-17272", "0.0.0-next-17272")).toBe(true)
  expect(isServiceVersionCompatible("0.0.0-next-17272", "0.0.0-next-17271")).toBe(true)
  expect(isServiceVersionCompatible("0.0.0-next-17271", "0.0.0-next-17272")).toBe(false)
  expect(isServiceVersionCompatible("0.0.0-next-15000", "0.0.0-next-9999")).toBe(true)
})

test("accepts incomparable development versions", () => {
  expect(isServiceVersionCompatible("development-a", "development-b")).toBe(true)
})
