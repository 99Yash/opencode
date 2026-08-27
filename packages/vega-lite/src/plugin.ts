import { Plugin } from "@opencode-ai/plugin/tui"
import { createVegaLiteCodeBlockRenderer } from "./markdown"

export default Plugin.define({
  id: "opencode.vega-lite",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "vega-lite",
      createVegaLiteCodeBlockRenderer(context.renderer, () => ({
        text: context.theme.text.default,
        subdued: context.theme.text.subdued,
        series: context.theme.categorical.map((scale) => scale[context.themeMode === "dark" ? 300 : 700]),
      })),
    )
  },
})
