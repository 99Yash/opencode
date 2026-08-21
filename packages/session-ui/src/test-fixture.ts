import type { Brand } from "effect"

export type Wire<T> = T extends Brand.Brand<string>
  ? Brand.Brand.Unbranded<T>
  : T extends ReadonlyArray<infer Item>
    ? Wire<Item>[]
    : T extends object
      ? { [Key in keyof T]: Wire<T[Key]> }
      : T

export function wire<T>(value: Wire<T>): T {
  return value as T
}
