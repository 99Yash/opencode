import type { RpcApi, RpcCallOptions, RpcEventPayload } from "@opencode-ai/client/promise/api"
import type { Rpc } from "@opencode-ai/schema/rpc"
import type { Registration } from "./registration.js"

export type { RpcEventPayload } from "@opencode-ai/client/promise/api"

declare const ReturnedErrorTypeId: unique symbol
interface ReturnedError {
  readonly [ReturnedErrorTypeId]: true
}

export interface RpcCallContext<M extends Rpc.Method> {
  readonly signal: AbortSignal
  readonly error: <Name extends Rpc.ErrorName<M>>(
    ...args: Rpc.ErrorArguments<M, Name>
  ) => Rpc.HandlerErrorFor<M, Name> & ReturnedError
}

export type RpcHandlers<D extends Rpc.PortableDefinition> = {
  readonly [Name in keyof D["methods"]]: (
    input: Rpc.Output<D["methods"][Name]["input"]>,
    context: RpcCallContext<D["methods"][Name]>,
  ) => Promise<
    Rpc.HandlerOutput<D["methods"][Name]["output"]> | (Rpc.HandlerError<D["methods"][Name]> & ReturnedError)
  >
}

export interface RpcRegistration<D extends Rpc.PortableDefinition> extends Registration {
  readonly events: {
    readonly emit: (...args: Rpc.EventInput<D>) => Promise<void>
  }
}

export interface RpcDomain
  extends RpcApi<Pick<RpcCallOptions, "signal"> & { readonly location?: never; readonly headers?: never }> {
  readonly register: <const D extends Rpc.PortableDefinition>(
    definition: D,
    handlers: RpcHandlers<NoInfer<D>>,
  ) => Promise<RpcRegistration<D>>
}
