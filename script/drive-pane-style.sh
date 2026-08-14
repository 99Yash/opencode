#!/usr/bin/env bash

# TEMPORARY: Recreates the fixed split-pane UI used for styling. Remove after that work is complete.

set -euo pipefail

name="${1:-pane-style2}"

send() {
  opencode-drive send --name "$name" "$@"
}

wait_for() {
  local text="$1"
  for _ in {1..100}; do
    if [[ "$(send --command.ui.matches "{\"text\":\"$text\"}")" == "true" ]]; then
      return
    fi
  done
  echo "error: timed out waiting for $text" >&2
  exit 1
}

send --command.ui.resize '{"cols":166,"rows":42}'
send --command.ui.type '{"text":"Create a styling session"}' --command.ui.enter
wait_for "shift+tab agents"

# Hide the session sidebar with the default <leader>b binding.
send \
  --command.ui.press '{"key":"x","modifiers":{"ctrl":true}}' \
  --command.ui.press '{"key":"b"}'

# Add two terminal panes through the session slash command.
send --command.ui.type '{"text":"/terminal"}' --command.ui.enter
send --command.ui.type '{"text":"/terminal"}' --command.ui.enter

for _ in {1..100}; do
  state="$(send --command.ui.state)"
  if [[ "$(grep -c 'embeddedTerminal-' <<<"$state")" -ge 2 ]]; then
    break
  fi
done
if [[ "$(grep -c 'embeddedTerminal-' <<<"$state")" -lt 2 ]]; then
  echo "error: two terminal panes did not open" >&2
  exit 1
fi

# Focus the newest right-hand pane and send keys separately so the visual interaction is explicit.
send --command.ui.click '{"target":2,"x":145,"y":20}'
send --command.ui.press '{"key":"l"}'
send --command.ui.press '{"key":"s"}'
send --command.ui.enter

echo "pane styling workspace ready in $name"
