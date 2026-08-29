import type { FormAnswer, FormReplyInput } from "@opencode-ai/client"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useData, type FormWithLocation } from "../../context/data"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { formLabel } from "../../util/form"
import { FormPrompt } from "./form"
import { formQuestionAnswers, QuestionAnswers } from "./question-answers"

export function SessionForm(props: {
  form?: FormWithLocation
  sessionID: string
  promptID?: string
  visible: boolean
}) {
  const data = useData()
  const theme = useTheme("elevated")
  const parentTheme = useTheme()
  const [selected, setSelected] = createSignal<{
    form: FormWithLocation
    submission: { answer: FormReplyInput["answer"] | undefined }
  }>()
  createEffect(
    on(
      () => props.promptID,
      () => setSelected(undefined),
      { defer: true },
    ),
  )
  createEffect(() => {
    const current = selected()
    if (current && props.form && (props.form.id !== current.form.id || props.form.sessionID !== current.form.sessionID))
      setSelected(undefined)
  })

  function inTranscript(form: FormWithLocation) {
    const tool = form.metadata?.tool
    if (
      form.metadata?.kind !== "question" ||
      form.sessionID !== props.sessionID ||
      !tool ||
      typeof tool !== "object" ||
      !("messageID" in tool) ||
      typeof tool.messageID !== "string" ||
      !("id" in tool)
    )
      return false
    const message = data.session.message.get(form.sessionID, tool.messageID)
    return (
      message?.type === "assistant" &&
      message.content.some((part) => part.type === "tool" && part.name === "question" && part.id === tool.id)
    )
  }

  function reply(form: FormWithLocation, answer: FormAnswer) {
    const request = data.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer }, form.location)
    // Capture the live owner before acknowledgement/terminal events can retire its lookup.
    const current =
      form.metadata?.kind === "question" && form.sessionID !== "global" && !inTranscript(form)
        ? { form, submission: data.session.form.submission(form.sessionID, form.id) ?? { answer } }
        : undefined
    if (current) setSelected(current)
    return request.catch((error: unknown) => {
      if (current && selected() === current) setSelected(undefined)
      throw error
    })
  }

  const local = createMemo(() => {
    const current = selected()
    return current?.submission.answer && !inTranscript(current.form) ? current : undefined
  })

  return (
    <box visible={props.visible}>
      <Show when={local()}>
        <box
          id="session.question.reply"
          backgroundColor={theme.background.default}
          border={["left"]}
          borderColor={parentTheme.background.default}
          customBorderChars={SplitBorder.customBorderChars}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          gap={1}
        >
          <text fg={theme.text.subdued}># Questions</text>
          <QuestionAnswers
            questions={local()?.form.fields.map((field) => ({ question: field.description ?? formLabel(field) })) ?? []}
            answers={formQuestionAnswers(local()?.submission.answer, local()?.form.fields.length ?? 0) ?? []}
          />
        </box>
      </Show>
      <Show when={props.visible && props.form?.id} keyed>
        {(_) => {
          const form = props.form
          if (!form) return null
          return (
            <FormPrompt
              form={form}
              answersVisible={
                inTranscript(form) || (selected()?.form.id === form.id && selected()?.form.sessionID === form.sessionID)
              }
              onReply={(answer) => reply(form, answer)}
            />
          )
        }}
      </Show>
    </box>
  )
}
