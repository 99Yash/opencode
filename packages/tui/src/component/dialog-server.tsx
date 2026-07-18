import { createMemo } from "solid-js"
import { useServer } from "../context/server"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export function DialogServer() {
  const server = useServer()
  const dialog = useDialog()
  const toast = useToast()
  const options = createMemo(() =>
    server.list().map((item) => ({
      title: item.name,
      description: item.url,
      value: item.id,
      onSelect: () => {
        dialog.clear()
        void server
          .select(item.id)
          .then(() => toast.show({ variant: "success", message: `Switched to ${item.name}` }), toast.error)
      },
    })),
  )

  function add() {
    void DialogPrompt.show(dialog, "Add server", {
      placeholder: "https://devbox.example",
      description: () => <text>Enter the URL of an OpenCode V2 server.</text>,
    }).then((value) => {
      if (!value) return
      dialog.clear()
      void server
        .add(value)
        .then(() => toast.show({ variant: "success", message: `Connected to ${server.current.name}` }), toast.error)
    })
  }

  return (
    <DialogSelect
      title="Switch server"
      options={options()}
      current={server.current.id}
      actions={[{ command: "server.add", title: "Add server", selection: "none", onTrigger: add }]}
    />
  )
}
