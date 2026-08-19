export function commandText(command: { name: string; arguments: string }) {
  return `/${command.name}${command.arguments ? ` ${command.arguments}` : ""}`
}
