import type { FormReplyInput } from "@opencode-ai/client"
import { For } from "solid-js"
import { useTheme } from "../../context/theme"

export function formQuestionAnswers(answer: FormReplyInput["answer"] | undefined, count: number) {
  if (!answer) return undefined
  return Array.from({ length: count }, (_, index) => {
    const value = answer[`q${index}`]
    if (value === undefined) return []
    return Array.isArray(value) ? value : [String(value)]
  })
}

export function QuestionAnswers(props: {
  questions: readonly { question: string }[]
  answers: readonly (readonly string[])[]
}) {
  const theme = useTheme()
  return (
    <box gap={1}>
      <For each={props.questions}>
        {(question, index) => (
          <box flexDirection="column">
            <text fg={theme.text.subdued}>{question.question}</text>
            <text fg={theme.text.default}>
              {props.answers[index()]?.length ? props.answers[index()].join(", ") : "(no answer)"}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}
