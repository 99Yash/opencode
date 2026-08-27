export * as Source from "./source.js"

import { Effect, Ref } from "effect"
import type { SessionSchema } from "./session/schema.js"

export interface Interface<T, E = never> {
  /** Return replacement values when changing state; consumers may reuse derived results by reference identity. */
  readonly get: (session: SessionSchema.Info) => Effect.Effect<T, E>
}

export type Value<T, E = never> = T | Interface<T, E>

export interface Mutable<T> extends Interface<T> {
  readonly set: (value: T) => Effect.Effect<void>
  readonly update: (update: (value: T) => T) => Effect.Effect<void>
}

export function mutable<T>(initial: T): Mutable<T> {
  const ref = Ref.makeUnsafe(initial)
  return {
    get: () => Ref.get(ref),
    set: (value) => Ref.set(ref, value),
    update: (update) => Ref.update(ref, update),
  }
}

export function constant<T>(value: T): Interface<T> {
  return { get: () => Effect.succeed(value) }
}

export function from<T, E = never>(value: Value<T, E>): Interface<T, E> {
  return isSource(value) ? value : constant(value)
}

function isSource<T, E>(value: Value<T, E>): value is Interface<T, E> {
  return typeof value === "object" && value !== null && "get" in value && typeof value.get === "function"
}
