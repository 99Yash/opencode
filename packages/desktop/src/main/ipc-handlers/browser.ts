import { BrowserWindow } from "electron"
import { Effect } from "effect"
import { BrowserRpcs } from "../../shared/ipc-rpc"
import { BrowserPane } from "../browser-pane"
import { IpcPortHandoff } from "../ipc-transport"
import { isRendererUrl } from "../windows/protocol"
import { sender, type RpcContext } from "./context"

export const browserHandlers = BrowserRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const browser = yield* BrowserPane.Service

    const owner = (context: RpcContext) => {
      const contents = sender(handoff, context)
      const win = BrowserWindow.fromWebContents(contents)
      if (!win || win.isDestroyed() || win.webContents !== contents || !isRendererUrl(contents.getURL())) {
        throw new Error("browser.pane.owner.invalid")
      }
      return win
    }
    return BrowserRpcs.of({
      BrowserPaneRegister: ({ binding }, context) =>
        Effect.tryPromise(() => browser.register(owner(context), binding)).pipe(Effect.orDie),
      BrowserPaneUnregister: ({ bindingID }, context) =>
        Effect.tryPromise(() => browser.unregister(owner(context), bindingID)).pipe(Effect.orDie),
      BrowserPaneSetLayout: ({ bindingID, layout }, context) =>
        Effect.sync(() => browser.setLayout(owner(context), bindingID, layout)),
      BrowserPaneCommand: ({ bindingID, command }, context) =>
        Effect.tryPromise(() => browser.command(owner(context), bindingID, command)).pipe(Effect.orDie),
      BrowserPaneGetState: ({ bindingID }, context) => Effect.sync(() => browser.state(owner(context), bindingID)),
    })
  }),
)
