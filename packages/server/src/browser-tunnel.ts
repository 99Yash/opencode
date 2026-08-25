export * as BrowserTunnelServer from "./browser-tunnel"

import { BrowserHost } from "@opencode-ai/core/browser-host"
import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Cause, Context, Effect, Fiber, Layer, Option, Queue, Result, Schema, Scope, SynchronizedRef } from "effect"
import { Socket } from "effect/unstable/socket"

const ActiveLimit = 64

type Writer = (data: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>

export class CapacityError extends Schema.TaggedError<CapacityError>()("BrowserTunnel.CapacityError", {
  limit: Schema.Int,
  message: Schema.String,
}) {}

class TunnelError extends Schema.TaggedError<TunnelError>()("BrowserTunnel.TunnelError", {
  kind: Schema.Literals(["closed", "protocol", "target", "revoked"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class OpenError extends Schema.TaggedError<OpenError>()("BrowserTunnel.OpenError", {
  code: BrowserTunnel.OpenErrorCode,
  message: Schema.String,
}) {}

export interface Connection {
  readonly run: (socket: Socket.Socket, opened?: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
}

export interface Interface {
  readonly acquire: Effect.Effect<Connection, CapacityError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/BrowserTunnel") {}

export function make() {
  return Effect.gen(function* () {
    const browser = yield* BrowserHost.Service
    const active = yield* SynchronizedRef.make(0)
    const acquire: Interface["acquire"] = Effect.acquireRelease(
      SynchronizedRef.modifyEffect(
        active,
        Effect.fnUntraced(function* (count) {
          if (count >= ActiveLimit) {
            return yield* new CapacityError({ limit: ActiveLimit, message: "Browser tunnel capacity is unavailable." })
          }
          return [undefined, count + 1] as const
        }),
      ),
      () => SynchronizedRef.update(active, (count) => count - 1),
    ).pipe(
      Effect.as({
        run: (socket: Socket.Socket, opened = Effect.void) =>
          Effect.gen(function* () {
            const write = yield* socket.writer
            yield* serve(browser, socket, write, opened).pipe(Effect.catch(() => Effect.void))
          }),
      }),
    )
    return Service.of({ acquire })
  })
}

export const layer = Layer.effect(Service, make())

const serve = Effect.fn("BrowserTunnel.serve")(function* (
  browser: BrowserHost.Interface,
  socket: Socket.Socket,
  write: Writer,
  onOpen: Effect.Effect<void>,
) {
  const incoming = yield* receive(socket, onOpen)
  const opened = yield* open(browser, incoming).pipe(Effect.result)
  if (Result.isFailure(opened)) {
    if (opened.failure instanceof OpenError) yield* reject(write, opened.failure)
    return
  }

  yield* write(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.opened" }))
  yield* relay(opened.success.target, incoming, write, opened.success.revoked).pipe(
    Effect.ensuring(close(write, 1000, "Browser tunnel closed")),
  )
})

function receive(socket: Socket.Socket, opened: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<string | Uint8Array, TunnelError>(16)
    const reader = yield* socket
      .runRaw(
        (message) => {
          if (typeof message !== "string" && message.byteLength > BrowserTunnelProtocol.MaxFrameBytes) {
            return Effect.fail(new TunnelError({ kind: "protocol", message: "Browser tunnel frame is too large." }))
          }
          return Queue.offer(queue, message).pipe(Effect.asVoid)
        },
        { onOpen: opened },
      )
      .pipe(
        Effect.onExit(() =>
          Effect.sync(() =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new TunnelError({ kind: "closed", message: "Browser tunnel closed." })),
            ),
          ),
        ),
        Effect.forkScoped,
      )
    return { queue, reader }
  })
}

function open(browser: BrowserHost.Interface, incoming: Effect.Success<ReturnType<typeof receive>>) {
  return Effect.gen(function* () {
    const request = yield* Queue.take(incoming.queue).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => new OpenError({ code: "invalid_open", message: "Browser tunnel open timed out." }),
      }),
      Effect.flatMap(BrowserTunnelProtocol.decodeFromClient),
      Effect.mapError((error) =>
        error instanceof OpenError
          ? error
          : new OpenError({ code: "invalid_open", message: "Browser tunnel open message is invalid." }),
      ),
    )
    const capability = yield* browser.get(request.sessionID)
    if (Option.isNone(capability) || capability.value.type !== "attached") {
      return yield* new OpenError({ code: "not_attached", message: "No browser is attached to this Session." })
    }
    if (capability.value.leaseID !== request.leaseID) {
      return yield* new OpenError({ code: "stale_lease", message: "The browser attachment lease is stale." })
    }

    const target = yield* Effect.raceFirst(
      connect(request.target.host, request.target.port),
      Effect.raceFirst(
        Fiber.join(incoming.reader).pipe(
          Effect.andThen(new TunnelError({ kind: "closed", message: "Browser tunnel closed." })),
        ),
        capability.value.revoked.pipe(
          Effect.andThen(new TunnelError({ kind: "revoked", message: "Browser lease was revoked." })),
        ),
      ),
    )
    return { target, revoked: capability.value.revoked }
  })
}

function relay(
  target: Effect.Success<ReturnType<typeof connect>>,
  incoming: Effect.Success<ReturnType<typeof receive>>,
  write: Writer,
  revoked: Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const outgoing = yield* receiveTarget(target)
    const fromClient = Effect.forever(
      Queue.take(incoming.queue).pipe(
        Effect.flatMap((message) =>
          typeof message === "string"
            ? new TunnelError({ kind: "protocol", message: "Tunnel payloads must be binary." })
            : writeTarget(target, message),
        ),
      ),
    )
    const fromTarget = Effect.forever(
      Queue.take(outgoing).pipe(
        Effect.flatMap((data) =>
          Effect.forEach(
            Array.from({ length: Math.ceil(data.byteLength / BrowserTunnelProtocol.MaxFrameBytes) }, (_, index) =>
              data.subarray(
                index * BrowserTunnelProtocol.MaxFrameBytes,
                (index + 1) * BrowserTunnelProtocol.MaxFrameBytes,
              ),
            ),
            write,
            { discard: true },
          ),
        ),
        Effect.ensuring(Effect.sync(() => target.resume())),
      ),
    )
    yield* Effect.raceFirst(
      Effect.all([fromClient, fromTarget], { concurrency: "unbounded", discard: true }),
      Effect.raceFirst(Fiber.join(incoming.reader), revoked),
    )
  })
}

function receiveTarget(target: Effect.Success<ReturnType<typeof connect>>) {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<Uint8Array, TunnelError>(1)
    const onData = (data: Buffer) => {
      target.pause()
      Queue.offerUnsafe(queue, data)
    }
    const onClose = () =>
      Queue.failCauseUnsafe(queue, Cause.fail(new TunnelError({ kind: "closed", message: "Target closed." })))
    const onError = (cause: Error) =>
      Queue.failCauseUnsafe(queue, Cause.fail(new TunnelError({ kind: "target", message: "Target failed.", cause })))
    target.on("data", onData)
    target.once("close", onClose)
    target.once("error", onError)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        target.off("data", onData)
        target.off("close", onClose)
        target.off("error", onError)
      }).pipe(Effect.andThen(Queue.shutdown(queue))),
    )
    return queue
  })
}

function connect(host: string, port: number) {
  return Effect.gen(function* () {
    const { Socket } = yield* Effect.promise(() => import("node:net"))
    return yield* Effect.acquireRelease(
      Effect.callback<InstanceType<typeof Socket>, OpenError>((resume) => {
        const socket = new Socket()
        const onError = () =>
          resume(
            Effect.fail(new OpenError({ code: "connect_failed", message: "Failed to connect browser tunnel target." })),
          )
        socket.once("error", onError)
        socket.connect(port, host, () => {
          socket.off("error", onError)
          socket.setNoDelay(true)
          resume(Effect.succeed(socket))
        })
        return Effect.sync(() => socket.destroy())
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            new OpenError({ code: "connect_timeout", message: "Browser tunnel target connection timed out." }),
        }),
      ),
      (socket) => Effect.sync(() => socket.destroy()),
    )
  })
}

function writeTarget(target: Effect.Success<ReturnType<typeof connect>>, data: Uint8Array) {
  return Effect.callback<void, TunnelError>((resume) => {
    target.write(data, (cause) =>
      resume(
        cause ? Effect.fail(new TunnelError({ kind: "target", message: "Target write failed.", cause })) : Effect.void,
      ),
    )
  })
}

function reject(write: Writer, error: OpenError) {
  return write(
    BrowserTunnelProtocol.encodeFromServer({
      type: "browser.tunnel.rejected",
      code: error.code,
      message: error.message,
    }),
  ).pipe(
    Effect.catch(() => Effect.void),
    Effect.andThen(close(write, 1000, error.message)),
  )
}

function close(write: Writer, code: number, reason: string) {
  return write(new Socket.CloseEvent(code, reason.slice(0, 123))).pipe(
    Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
    Effect.catch(() => Effect.void),
  )
}
