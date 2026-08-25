import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))
const bindingID = text(128)

export const BrowserPaneBindingSchema = Schema.Struct({
  sessionID: text(256).check(Schema.isStartsWith("ses")),
  bindingID,
  endpoint: Schema.Struct({
    url: text(16_384),
    username: Schema.optionalKey(text(1_024)),
    password: Schema.optionalKey(text(4_096)),
  }),
})

export const BrowserPaneLayoutSchema = Schema.Struct({
  visible: Schema.Boolean,
  bounds: Schema.optionalKey(
    Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite }),
  ),
})

export const BrowserPaneCommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("navigate"), url: text(16_384) }),
  Schema.Struct({ type: Schema.Literals(["back", "forward", "reload", "stop"]) }),
])

export const BrowserPaneStateSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  ready: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
})

export const BrowserPaneRegister = Rpc.make("BrowserPaneRegister", {
  payload: { binding: BrowserPaneBindingSchema },
})
export const BrowserPaneUnregister = Rpc.make("BrowserPaneUnregister", {
  payload: { bindingID },
})
export const BrowserPaneSetLayout = Rpc.make("BrowserPaneSetLayout", {
  payload: { bindingID, layout: Schema.optionalKey(BrowserPaneLayoutSchema) },
})
export const BrowserPaneCommand = Rpc.make("BrowserPaneCommand", {
  payload: { bindingID, command: BrowserPaneCommandSchema },
})
export const BrowserPaneGetState = Rpc.make("BrowserPaneGetState", {
  payload: { bindingID },
  success: BrowserPaneStateSchema,
})

export const BrowserRpcs = RpcGroup.make(
  BrowserPaneRegister,
  BrowserPaneUnregister,
  BrowserPaneSetLayout,
  BrowserPaneCommand,
  BrowserPaneGetState,
)
