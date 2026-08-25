export * as BrowserHost from "./browser-host.js"

import { Browser } from "@opencode-ai/schema/browser"
import { Session } from "@opencode-ai/schema/session"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { Bus } from "./bus.js"
import { SessionEvent } from "./session/event.js"
import { SessionStore } from "./session/store.js"

export class RegistrationError extends Schema.TaggedError<RegistrationError>()("BrowserHost.RegistrationError", {
  reason: Schema.Literals(["unknown_session", "already_registered", "stale_registration", "stale_lease"]),
  message: Schema.String,
}) {}

export class RequestError extends Schema.TaggedError<RequestError>()("BrowserHost.RequestError", {
  code: Browser.ErrorCode,
  message: Schema.String,
}) {}

export interface Peer {
  readonly open: Effect.Effect<void, RequestError>
  readonly request: (command: Browser.Command, leaseID: Browser.LeaseID) => Effect.Effect<Browser.Result, RequestError>
}

export interface Controller {
  readonly attach: (leaseID: Browser.LeaseID, state: Browser.State) => Effect.Effect<void, RegistrationError>
  readonly state: (leaseID: Browser.LeaseID, state: Browser.State) => Effect.Effect<void, RegistrationError>
  readonly detach: (leaseID: Browser.LeaseID) => Effect.Effect<void, RegistrationError>
}

export interface Available {
  readonly type: "available"
  readonly open: Effect.Effect<void, RequestError>
}

export interface Attached {
  readonly type: "attached"
  readonly leaseID: Browser.LeaseID
  readonly state: Browser.State
  readonly revoked: Effect.Effect<void>
  readonly request: (command: Browser.Command) => Effect.Effect<Browser.Result, RequestError>
}

export type Capability = Available | Attached

export interface Interface {
  readonly register: (sessionID: Session.ID, peer: Peer) => Effect.Effect<Controller, RegistrationError, Scope.Scope>
  readonly get: (sessionID: Session.ID) => Effect.Effect<Option.Option<Capability>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserHost") {}

type Attachment = {
  readonly leaseID: Browser.LeaseID
  readonly revoked: Deferred.Deferred<void>
  state: Browser.State
}

type Registration = {
  readonly peer: Peer
  readonly closed: Deferred.Deferred<void>
  attached: Deferred.Deferred<void>
  attachment?: Attachment
}

type Registrations = Map<Session.ID, Registration>

export function make(
  sessionExists: (sessionID: Session.ID) => Effect.Effect<boolean>,
  deleted: Stream.Stream<Session.ID> = Stream.never,
) {
  return Effect.gen(function* () {
    const registrations: Registrations = new Map()

    const register: Interface["register"] = Effect.fn("BrowserHost.register")(function* (sessionID, peer) {
      if (!(yield* sessionExists(sessionID))) {
        return yield* new RegistrationError({
          reason: "unknown_session",
          message: "The browser Session does not exist.",
        })
      }
      const registration = yield* acquire(registrations, sessionID, peer)
      return controller(registrations, sessionID, registration)
    })

    const get: Interface["get"] = Effect.fn("BrowserHost.get")(function* (sessionID) {
      const registration = registrations.get(sessionID)
      if (!registration) return Option.none()
      if (!(yield* sessionExists(sessionID))) {
        yield* release(registrations, sessionID)
        return Option.none()
      }
      return Option.some(capability(registrations, sessionID, registration))
    })

    yield* Stream.runForEach(deleted, (sessionID) => release(registrations, sessionID)).pipe(Effect.forkScoped)
    return Service.of({ register, get })
  })
}

function acquire(registrations: Registrations, sessionID: Session.ID, peer: Peer) {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      if (registrations.has(sessionID)) {
        return new RegistrationError({
          reason: "already_registered",
          message: "The browser Session is already registered.",
        })
      }
      const registration = {
        peer,
        closed: Deferred.makeUnsafe<void>(),
        attached: Deferred.makeUnsafe<void>(),
      }
      registrations.set(sessionID, registration)
      return Effect.succeed(registration)
    }),
    (registration) => release(registrations, sessionID, registration),
  )
}

function controller(registrations: Registrations, sessionID: Session.ID, registration: Registration): Controller {
  return {
    attach: Effect.fn("BrowserHost.attach")((leaseID, state) =>
      Effect.suspend(() => {
        const error = invalid(registrations, sessionID, registration)
        if (error) return error
        const previous = registration.attachment
        registration.attachment = { leaseID, state, revoked: Deferred.makeUnsafe<void>() }
        if (previous) Deferred.doneUnsafe(previous.revoked, Effect.void)
        Deferred.doneUnsafe(registration.attached, Effect.void)
        return Effect.void
      }),
    ),
    state: Effect.fn("BrowserHost.state")((leaseID, state) =>
      Effect.suspend(() => {
        const error = invalid(registrations, sessionID, registration, leaseID)
        if (error) return error
        const attachment = registration.attachment
        if (attachment) attachment.state = state
        return Effect.void
      }),
    ),
    detach: Effect.fn("BrowserHost.detach")((leaseID) =>
      Effect.suspend(() => {
        const error = invalid(registrations, sessionID, registration, leaseID)
        if (error) return error
        const attachment = registration.attachment
        registration.attachment = undefined
        registration.attached = Deferred.makeUnsafe<void>()
        if (attachment) Deferred.doneUnsafe(attachment.revoked, Effect.void)
        return Effect.void
      }),
    ),
  }
}

function capability(registrations: Registrations, sessionID: Session.ID, registration: Registration): Capability {
  const attachment = registration.attachment
  if (attachment) {
    return {
      type: "attached",
      leaseID: attachment.leaseID,
      state: attachment.state,
      revoked: Deferred.await(attachment.revoked),
      request: (command) =>
        Effect.suspend(() => {
          if (registrations.get(sessionID) !== registration || registration.attachment !== attachment) {
            return unavailable()
          }
          return registration.peer.request(command, attachment.leaseID).pipe(
            Effect.raceFirst(Deferred.await(attachment.revoked).pipe(Effect.andThen(unavailable()))),
            Effect.flatMap((result) =>
              result.type === command.type
                ? Effect.succeed(result)
                : new RequestError({ code: "protocol", message: "Browser response does not match its command." }),
            ),
          )
        }),
    }
  }

  const attached = registration.attached
  return {
    type: "available",
    open: Effect.suspend(() => {
      if (
        registrations.get(sessionID) !== registration ||
        registration.attached !== attached ||
        registration.attachment
      ) {
        return unavailable()
      }
      return registration.peer.open.pipe(
        Effect.andThen(Deferred.await(attached)),
        Effect.raceFirst(Deferred.await(registration.closed).pipe(Effect.andThen(unavailable()))),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => new RequestError({ code: "timeout", message: "Browser pane did not open." }),
        }),
      )
    }),
  }
}

function invalid(
  registrations: Registrations,
  sessionID: Session.ID,
  registration: Registration,
  leaseID?: Browser.LeaseID,
) {
  if (registrations.get(sessionID) !== registration) {
    return new RegistrationError({
      reason: "stale_registration",
      message: "The browser registration is no longer active.",
    })
  }
  if (leaseID !== undefined && registration.attachment?.leaseID !== leaseID) {
    return new RegistrationError({
      reason: "stale_lease",
      message: "The browser attachment lease is no longer active.",
    })
  }
}

function release(registrations: Registrations, sessionID: Session.ID, registration?: Registration) {
  return Effect.sync(() => {
    const current = registrations.get(sessionID)
    if (!current || (registration && current !== registration)) return
    registrations.delete(sessionID)
    Deferred.doneUnsafe(current.closed, Effect.void)
    if (current.attachment) Deferred.doneUnsafe(current.attachment.revoked, Effect.void)
  })
}

function unavailable() {
  return new RequestError({ code: "not_attached", message: "The browser attachment is no longer available." })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* SessionStore.Service
    const bus = yield* Bus.Service
    return yield* make(
      (sessionID) => sessions.get(sessionID).pipe(Effect.map((session) => session !== undefined)),
      bus.subscribe(SessionEvent.Deleted).pipe(Stream.map((event) => event.data.sessionID)),
    )
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SessionStore.node, Bus.node] })
