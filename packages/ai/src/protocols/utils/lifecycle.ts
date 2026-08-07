import {
  LLMEvent,
  type FinishReasonDetails,
  type ProviderMetadata,
  type ResponseItemID,
  type Usage,
} from "../../schema"

export interface State {
  readonly stepStarted: boolean
  readonly text: ReadonlySet<string>
  readonly reasoning: ReadonlySet<string>
}

export const initial = (): State => ({ stepStarted: false, text: new Set(), reasoning: new Set() })

export const stepStart = (state: State, events: LLMEvent[]): State => {
  if (state.stepStarted) return state
  events.push(LLMEvent.stepStart({ index: 0 }))
  return { ...state, stepStarted: true }
}

export const textStart = (
  state: State,
  events: LLMEvent[],
  id: string,
  providerMetadata?: ProviderMetadata,
  itemId?: ResponseItemID,
): State => {
  if (state.text.has(id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.textStart({ id, ...(itemId === undefined ? {} : { itemId }), providerMetadata }))
  return { ...stepped, text: new Set([...stepped.text, id]) }
}

export const textDelta = (
  state: State,
  events: LLMEvent[],
  id: string,
  text: string,
  providerMetadata?: ProviderMetadata,
  itemId?: ResponseItemID,
): State => {
  const started = textStart(state, events, id, providerMetadata, itemId)
  events.push(LLMEvent.textDelta({ id, ...(itemId === undefined ? {} : { itemId }), text, providerMetadata }))
  return started
}

export const reasoningStart = (
  state: State,
  events: LLMEvent[],
  id: string,
  providerMetadata?: ProviderMetadata,
  itemId?: ResponseItemID,
): State => {
  if (state.reasoning.has(id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.reasoningStart({ id, ...(itemId === undefined ? {} : { itemId }), providerMetadata }))
  return { ...stepped, reasoning: new Set([...stepped.reasoning, id]) }
}

export const reasoningDelta = (
  state: State,
  events: LLMEvent[],
  id: string,
  text: string,
  providerMetadata?: ProviderMetadata,
  itemId?: ResponseItemID,
): State => {
  const started = reasoningStart(state, events, id, providerMetadata, itemId)
  events.push(LLMEvent.reasoningDelta({ id, ...(itemId === undefined ? {} : { itemId }), text, providerMetadata }))
  return started
}

export const reasoningEnd = (
  state: State,
  events: LLMEvent[],
  id: string,
  providerMetadata?: ProviderMetadata,
  itemId?: ResponseItemID,
): State => {
  if (!state.reasoning.has(id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.reasoningEnd({ id, ...(itemId === undefined ? {} : { itemId }), providerMetadata }))
  const reasoning = new Set(stepped.reasoning)
  reasoning.delete(id)
  return { ...stepped, reasoning }
}

export const textEnd = (
  state: State,
  events: LLMEvent[],
  id: string,
  providerMetadata?: ProviderMetadata,
  itemId?: ResponseItemID,
): State => {
  if (!state.text.has(id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.textEnd({ id, ...(itemId === undefined ? {} : { itemId }), providerMetadata }))
  const text = new Set(stepped.text)
  text.delete(id)
  return { ...stepped, text }
}

const closeOpenBlocks = (state: State, events: LLMEvent[]): State => {
  for (const id of state.reasoning) events.push(LLMEvent.reasoningEnd({ id }))
  for (const id of state.text) events.push(LLMEvent.textEnd({ id }))
  return { ...state, text: new Set(), reasoning: new Set() }
}

export const finish = (
  state: State,
  events: LLMEvent[],
  input: {
    readonly reason: FinishReasonDetails
    readonly usage?: Usage
    readonly providerMetadata?: ProviderMetadata
  },
): State => {
  const stepped = closeOpenBlocks(stepStart(state, events), events)
  events.push(
    LLMEvent.stepFinish({
      index: 0,
      reason: input.reason,
      usage: input.usage,
      providerMetadata: input.providerMetadata,
    }),
    LLMEvent.finish(input),
  )
  return { ...stepped, stepStarted: false }
}

export * as Lifecycle from "./lifecycle"
