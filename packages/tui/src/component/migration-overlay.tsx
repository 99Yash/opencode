import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { Spinner } from "./spinner"

export function MigrationOverlay(props: {
  progress: { label: string; numerator?: number; denominator?: number }
}) {
  const theme = useTheme("overlay")
  const count = () => {
    if (props.progress.numerator === undefined) return ""
    if (props.progress.denominator === undefined) return ` ${props.progress.numerator}`
    return ` ${props.progress.numerator}/${props.progress.denominator}`
  }

  return (
    <box
      position="absolute"
      zIndex={10_000}
      top={1}
      right={2}
      flexDirection="row"
      backgroundColor={theme.background.default}
      border={["left"]}
      borderColor={theme.text.feedback.info.default}
      customBorderChars={SplitBorder.customBorderChars}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Spinner color={theme.text.feedback.info.default}>
        {props.progress.label}
        {count()}
      </Spinner>
    </box>
  )
}
