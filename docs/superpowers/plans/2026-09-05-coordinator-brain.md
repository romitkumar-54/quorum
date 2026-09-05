# Coordinator-Owned Brain — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interviewers' hardcoded lines with LLM-generated ones that answer what the candidate actually said, without weakening the coordinator's control of the floor.

**Architecture:** The coordinator keeps deciding *who* speaks and *why*; a new `LlmGenerator` decides *what* they say. Generation becomes async behind the existing `QuestionGenerator` interface, the API key stays server-side behind a thin route, and any failure or timeout falls back to today's `ScriptedGenerator`.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Vitest, OpenAI-compatible chat-completions API.

**Spec:** `docs/superpowers/specs/2026-09-05-coordinator-brain-design.md`

## Global Constraints

- Node 22, Next.js 16.3.4, Vitest 5. Test environment is `node`; tests live in `tests/**/*.test.ts`.
- Path alias `@` resolves to `src/` (see `vitest.config.mts`).
- No new runtime dependencies. The LLM call uses `fetch`.
- The API key is read only in `src/app/api/**`. It must never reach a client component.
- Every existing test must still pass. There are 35 today; `npx vitest run` is the gate.
- `ScriptedGenerator` keeps its current behaviour exactly. It is both the fallback and what the rehearsed demo runs on.
- Transcript append order must stay deterministic even when lines are generated in parallel.

---

### Task 1: Make the generator seam async

Mechanical, no behaviour change. Everything must be green at the end with identical assertions.

**Files:**
- Modify: `src/agents/index.ts:23-25` (interface), `src/agents/index.ts:31-50` (ScriptedGenerator)
- Modify: `src/core/session.ts:89` (`candidateSays`), `src/core/session.ts:177-201` (`speak`)
- Modify: `src/app/page.tsx:194`, `src/app/page.tsx:222`
- Modify: `tests/coordinator.test.ts:11`, `tests/coordinator.test.ts:50`
- Modify: `tests/brief.test.ts:80`, `tests/brief.test.ts:120`, `tests/brief.test.ts:133`

**Interfaces:**
- Consumes: nothing.
- Produces: `QuestionGenerator.next(input: GenerationInput): Promise<string>`; `InterviewSession.candidateSays(text: string, at?: number): Promise<SessionStep>`; `InterviewSession.compose(...)` and `InterviewSession.append(...)` as private helpers.

- [ ] **Step 1: Write the failing test**

Add to `tests/coordinator.test.ts`:

```typescript
it('generates the lines of a collision in parallel but appends them in bid order', async () => {
  const order: string[] = []
  const slow: QuestionGenerator = {
    async next({ agent }) {
      // technical resolves last; the transcript must not reorder because of it.
      await new Promise((r) => setTimeout(r, agent === 'technical' ? 20 : 1))
      order.push(agent)
      return `line from ${agent}`
    },
  }
  const session = new InterviewSession({ mode: 'naive', generator: slow, ...fixed })
  const step = await session.candidateSays(DEMO_TRANSCRIPT[0].text, DEMO_TRANSCRIPT[0].at)

  const collision = step.decisions[0]
  if (collision.kind !== 'collision' || !collision.collidedWith) throw new Error('expected a collision')
  expect(step.utterances.map((u) => u.speaker)).toEqual(collision.collidedWith)
})
```

Add `import type { QuestionGenerator } from '@/agents'` to the top of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coordinator.test.ts`
Expected: FAIL — `candidateSays(...).then is not a function`, or a type error that `await` on a non-Promise yields `SessionStep` with no `decisions` resolution. Either is the correct failure: the method is still synchronous.

- [ ] **Step 3: Make the interface async**

In `src/agents/index.ts`:

```typescript
export interface QuestionGenerator {
  next(input: GenerationInput): Promise<string>
}

export class ScriptedGenerator implements QuestionGenerator {
  async next({ agent, brief, justifiedBy }: GenerationInput): Promise<string> {
    const flag = justifiedBy[0]
    // ...rest of the body is unchanged
```

- [ ] **Step 4: Split `speak` so only generation is parallel**

Replace `speak` in `src/core/session.ts` with these three members:

```typescript
  /** Produce an agent's line. The only async step, and the only one worth parallelising. */
  private async compose(
    agent: AgentId,
    decision: FloorDecision,
    flagIds: string[],
    addressFlags = true,
  ): Promise<string> {
    const justifiedBy = this.flagsById(flagIds)
    if (addressFlags) this.brief.markAddressed(justifiedBy.map((f) => f.id))

    return this.generator.next({
      agent,
      brief: this.brief.current(),
      decision,
      justifiedBy,
      transcript: this.transcript.all(),
    })
  }

  /** Record a line. Synchronous, so transcript order never depends on who resolved first. */
  private append(agent: AgentId, text: string, at: number): TranscriptEvent {
    return this.transcript.append({
      speaker: agent,
      text,
      tStart: at,
      tEnd: at + estimateDuration(text),
    })
  }

  private async speak(
    agent: AgentId,
    decision: FloorDecision,
    at: number,
    flagIds: string[],
    addressFlags = true,
  ): Promise<TranscriptEvent> {
    const text = await this.compose(agent, decision, flagIds, addressFlags)
    return this.append(agent, text, at)
  }
```

- [ ] **Step 5: Make `candidateSays` async**

Change the signature at `src/core/session.ts:89` to:

```typescript
  async candidateSays(text: string, at?: number): Promise<SessionStep> {
```

Replace the collision branch so generation fans out and appending stays ordered:

```typescript
    if (grant.kind === 'collision' && grant.collidedWith) {
      const lines = await Promise.all(
        grant.collidedWith.map((agent) => {
          const backing = grant.bids.find((b) => b.agent === agent)?.backedBy ?? []
          // Nothing lands when three people speak at once, so the flags they were
          // each reacting to stay open — and the panel collides again next turn.
          return this.compose(agent, grant, backing, false)
        }),
      )
      for (const [i, agent] of grant.collidedWith.entries()) {
        utterances.push(this.append(agent, lines[i], grant.tDecision))
      }
      return { candidateEvent, brief: this.brief.current(), decisions, utterances }
    }
```

Add `await` to the two remaining `this.speak(...)` calls in the same method — the floor holder and the interrupt.

- [ ] **Step 6: Update the seven call sites**

`src/app/page.tsx:194` and `src/app/page.tsx:222` — both are already inside `async` functions:

```typescript
await play(await session.candidateSays(text, at))
```

`tests/coordinator.test.ts:11` — `runDemo` becomes async:

```typescript
async function runDemo(mode: 'naive' | 'coordinated') {
  const session = new InterviewSession({ mode, ...fixed })
  const steps: SessionStep[] = []
  for (const t of DEMO_TRANSCRIPT) steps.push(await session.candidateSays(t.text, t.at))
  return { session, steps, decisions: session.coordinator.log() }
}
```

Add `import { InterviewSession, type SessionStep } from '@/core/session'`. Every caller of `runDemo` becomes `const { ... } = await runDemo(...)` inside an `async` test.

`tests/coordinator.test.ts:50` and the three `forEach` loops in `tests/brief.test.ts` become `for...of` with `await`:

```typescript
for (const t of DEMO_TRANSCRIPT) await session.candidateSays(t.text, t.at)
```

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, 36 tests (35 existing + the new ordering test).

- [ ] **Step 8: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`, TypeScript clean.

- [ ] **Step 9: Commit**

```bash
git add src/agents/index.ts src/core/session.ts src/app/page.tsx tests/
git commit -m "refactor: make line generation async behind QuestionGenerator"
```

---

### Task 2: Personas

**Files:**
- Create: `src/agents/personas.ts`
- Test: `tests/personas.test.ts`

**Interfaces:**
- Consumes: `AgentId`, `AGENTS` from `@/core/contracts`.
- Produces: `buildSystemPrompt(agent: AgentId): string`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest'
import { AGENT_IDS } from '@/core/contracts'
import { buildSystemPrompt } from '@/agents/personas'

describe('each interviewer has a persona of its own', () => {
  it('gives every agent a distinct system prompt', () => {
    const prompts = AGENT_IDS.map(buildSystemPrompt)
    expect(new Set(prompts).size).toBe(AGENT_IDS.length)
  })

  it('states the hard constraints in every persona', () => {
    for (const id of AGENT_IDS) {
      const prompt = buildSystemPrompt(id)
      expect(prompt).toMatch(/one question/i)
      expect(prompt).toMatch(/two sentences/i)
    }
  })

  it('tells the technical interviewer what it owns', () => {
    expect(buildSystemPrompt('technical')).toMatch(/correctness|complexity|trade-?offs/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/personas.test.ts`
Expected: FAIL — `Cannot find module '@/agents/personas'`.

- [ ] **Step 3: Write the personas**

```typescript
/**
 * Who each interviewer is.
 *
 * `AgentProfile.role` is a label for the UI. This is the thing that actually
 * shapes speech: register, sentence length, and what the interviewer refuses to
 * let past. Kept out of contracts.ts so that file stays a registry.
 */

import { AGENTS, type AgentId } from '@/core/contracts'

/** Rules every interviewer obeys, whatever their personality. */
const HOUSE_RULES = [
  'Ask exactly one question. Never stack a second onto it.',
  'At most two sentences. No preamble, no "great question", no restating what they said.',
  'Speak it aloud — this is a voice channel, so no lists, no markdown, no code blocks.',
  'Stay in character. Never mention being a model, a prompt, or an AI.',
  'If you were given a reason for taking the floor, ask about that and nothing else.',
].join('\n- ')

const PERSONAS: Record<AgentId, string> = {
  technical: [
    'You are the technical interviewer on a three-person panel: a senior engineer',
    'who has shipped systems that broke in production and remembers why.',
    'You care about correctness, complexity and trade-offs, in that order.',
    'You are not hostile, but you are hard to satisfy — a claim without a mechanism',
    'behind it is not an answer. You speak plainly and short.',
  ].join(' '),

  product: [
    'You are the product interviewer on a three-person panel: a product manager who',
    'has watched good engineering solve problems nobody had.',
    'You care about impact — who was helped, by how much, and how anyone knew.',
    'You are warm and genuinely curious, and you keep returning to the person on the',
    'other end of the work until you get a number or an admission there isn\'t one.',
  ].join(' '),

  behavioural: [
    'You are the behavioural interviewer on a three-person panel: a hiring manager',
    'who has seen confident people crumble and quiet people hold.',
    'You care about consistency and how the candidate handles pressure.',
    'You listen for the gap between two things they said, and you name it calmly,',
    'without accusation. You are the least technical voice and the hardest to fool.',
  ].join(' '),
}

export function buildSystemPrompt(agent: AgentId): string {
  return [
    PERSONAS[agent],
    `\nYou own the competency "${AGENTS[agent].owns}".`,
    `\nRules:\n- ${HOUSE_RULES}`,
  ].join('')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/personas.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/personas.ts tests/personas.test.ts
git commit -m "feat: give each interviewer a persona"
```

---

### Task 3: Prompt assembly

The task that protects the project's central property: the line must be about the reason the floor was granted.

**Files:**
- Create: `src/agents/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt` from Task 2; `GenerationInput` from `@/agents`.
- Produces: `type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }`; `buildMessages(input: GenerationInput): ChatMessage[]`; `const TRANSCRIPT_WINDOW = 6`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import { buildMessages } from '@/agents/prompt'
import type { GenerationInput } from '@/agents'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

/** Run the demo far enough that the brief holds a real flag. */
async function inputWithFlag(): Promise<GenerationInput> {
  let captured: GenerationInput | null = null
  const spy = {
    async next(input: GenerationInput) {
      if (input.justifiedBy.length > 0 && !captured) captured = input
      return 'noted'
    },
  }
  const session = new InterviewSession({ mode: 'coordinated', generator: spy, ...fixed })
  for (const t of DEMO_TRANSCRIPT) await session.candidateSays(t.text, t.at)
  if (!captured) throw new Error('the demo produced no justified grant')
  return captured
}

describe('the prompt carries the reason the floor was granted', () => {
  it('names the flag the agent won the floor on', async () => {
    const input = await inputWithFlag()
    const text = buildMessages(input).map((m) => m.content).join('\n')
    expect(text).toContain(input.justifiedBy[0].kind)
  })

  it('quotes the evidence behind that flag', async () => {
    const input = await inputWithFlag()
    const quote = input.justifiedBy[0].evidence[0]?.quote
    if (!quote) throw new Error('flag had no evidence')
    const text = buildMessages(input).map((m) => m.content).join('\n')
    expect(text).toContain(quote)
  })

  it('opens with the agent persona as a system message', async () => {
    const input = await inputWithFlag()
    const messages = buildMessages(input)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toMatch(/one question/i)
  })

  it('includes the difficulty so the ladder still climbs', async () => {
    const input = await inputWithFlag()
    const text = buildMessages(input).map((m) => m.content).join('\n')
    expect(text).toContain(`Difficulty: ${input.brief.difficulty}`)
  })

  it('sends at most the last six transcript turns', async () => {
    const input = await inputWithFlag()
    const text = buildMessages(input).map((m) => m.content).join('\n')
    const spoken = input.transcript.slice(-6)
    const dropped = input.transcript.slice(0, -6)
    for (const event of spoken) expect(text).toContain(event.text)
    for (const event of dropped) expect(text).not.toContain(event.text)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — `Cannot find module '@/agents/prompt'`.

- [ ] **Step 3: Write the assembler**

```typescript
/**
 * Turning a floor grant into a prompt.
 *
 * The important line in this file is the one that renders `justifiedBy`. The
 * coordinator already decided why this agent is speaking; putting that reason
 * in front of the model is what keeps the words out of the speaker matching the
 * reason on screen — the property the whole demo rests on.
 */

import type { GenerationInput } from '@/agents'
import { buildSystemPrompt } from '@/agents/personas'
import { formatTimestamp } from '@/core/transcript'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** How much conversation the model sees. Enough for context, short enough to stay cheap. */
export const TRANSCRIPT_WINDOW = 6

export function buildMessages(input: GenerationInput): ChatMessage[] {
  const { brief, justifiedBy, transcript } = input

  const claims = brief.claims.length
    ? brief.claims.map((c) => `- ${c.competency}: ${c.text}`).join('\n')
    : '- nothing claimed yet'

  const recent = transcript
    .slice(-TRANSCRIPT_WINDOW)
    .map((e) => `[${formatTimestamp(e.tStart)}] ${e.speaker}: ${e.text}`)
    .join('\n')

  const reason = justifiedBy.length
    ? justifiedBy
        .map((f) => {
          const evidence = f.evidence
            .map((e) => `    at ${formatTimestamp(e.t)} they said "${e.quote}"`)
            .join('\n')
          return `- ${f.kind}\n${evidence}`
        })
        .join('\n')
    : '- nothing specific; ask the next question at this difficulty'

  return [
    { role: 'system', content: buildSystemPrompt(input.agent) },
    {
      role: 'user',
      content: [
        'SHARED BRIEF — what the panel already knows.',
        claims,
        `Difficulty: ${brief.difficulty}`,
        '',
        'RECENT CONVERSATION',
        recent,
        '',
        'YOU HAVE THE FLOOR BECAUSE:',
        reason,
        '',
        'Ask your one question now. Speak only the question.',
      ].join('\n'),
    },
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompt.ts tests/prompt.test.ts
git commit -m "feat: assemble interviewer prompts from the brief and the floor reason"
```

---

### Task 4: The LLM call

**Files:**
- Create: `src/agents/llmClient.ts`
- Test: `tests/llmClient.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from Task 3.
- Produces: `requestCompletion(messages: ChatMessage[], opts: CompletionOptions): Promise<string>` where `CompletionOptions = { url: string; apiKey: string; model: string; timeoutMs?: number; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { requestCompletion } from '@/agents/llmClient'

const opts = { url: 'https://example.invalid/v1/chat/completions', apiKey: 'k', model: 'm' }
const messages = [{ role: 'system' as const, content: 'be brief' }]

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

describe('requesting one interviewer line', () => {
  it('returns the assistant content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('  What does that cost you?  '))
    const text = await requestCompletion(messages, { ...opts, fetchImpl })
    expect(text).toBe('What does that cost you?')
  })

  it('sends the key as a bearer token and never in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply('ok'))
    await requestCompletion(messages, { ...opts, fetchImpl })
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(init.body).not.toContain('"k"')
  })

  it('throws when the provider returns an error status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 429 }))
    await expect(requestCompletion(messages, { ...opts, fetchImpl })).rejects.toThrow(/429/)
  })

  it('throws when the response carries no choices', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(requestCompletion(messages, { ...opts, fetchImpl })).rejects.toThrow(/no completion/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llmClient.test.ts`
Expected: FAIL — `Cannot find module '@/agents/llmClient'`.

- [ ] **Step 3: Write the client**

```typescript
/**
 * One chat completion, in the OpenAI-compatible shape.
 *
 * `fetch` is a parameter so this is testable without a network, and so the
 * route can pass its own. Nothing here reads process.env: the caller owns
 * configuration, which keeps the key out of every layer but the route.
 */

import type { ChatMessage } from '@/agents/prompt'

export interface CompletionOptions {
  url: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface CompletionResponse {
  choices?: { message?: { content?: string } }[]
}

export async function requestCompletion(
  messages: ChatMessage[],
  { url, apiKey, model, timeoutMs = 8000, fetchImpl = fetch }: CompletionOptions,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 120 }),
      signal: controller.signal,
    })

    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`)

    const body = (await res.json()) as CompletionResponse
    const text = body.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('LLM returned no completion')
    return text
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llmClient.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/llmClient.ts tests/llmClient.test.ts
git commit -m "feat: add an OpenAI-compatible completion client"
```

---

### Task 5: `LlmGenerator` and its fallback

**Files:**
- Create: `src/agents/llm.ts`
- Test: `tests/llmGenerator.test.ts`

**Interfaces:**
- Consumes: `buildMessages` (Task 3); `QuestionGenerator`, `GenerationInput`, `ScriptedGenerator` from `@/agents`.
- Produces: `class LlmGenerator implements QuestionGenerator`, constructed as `new LlmGenerator({ fallback, timeoutMs?, endpoint?, fetchImpl? })`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { InterviewSession } from '@/core/session'
import { DEMO_TRANSCRIPT } from '@/core/demo'
import { ScriptedGenerator, type GenerationInput } from '@/agents'
import { LlmGenerator } from '@/agents/llm'

const fixed = { decisionLatency: () => 50, holdBeforeRecheck: () => 1600 }

async function anyInput(): Promise<GenerationInput> {
  let captured: GenerationInput | null = null
  const spy = { async next(input: GenerationInput) { captured ??= input; return 'noted' } }
  const session = new InterviewSession({ mode: 'coordinated', generator: spy, ...fixed })
  await session.candidateSays(DEMO_TRANSCRIPT[0].text, DEMO_TRANSCRIPT[0].at)
  if (!captured) throw new Error('no generation happened')
  return captured
}

const ok = (text: string) => new Response(JSON.stringify({ text }), { status: 200 })

describe('the LLM generator, and what happens when it fails', () => {
  it('returns the line the route produced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('What breaks at ten million keys?'))
    const gen = new LlmGenerator({ fallback: new ScriptedGenerator(), fetchImpl })
    expect(await gen.next(await anyInput())).toBe('What breaks at ten million keys?')
  })

  it('falls back to the scripted line when the route errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const input = await anyInput()
    const scripted = new ScriptedGenerator()
    const gen = new LlmGenerator({ fallback: scripted, fetchImpl })
    expect(await gen.next(input)).toBe(await scripted.next(input))
  })

  it('falls back when the route is slower than the budget', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok('too late')), 200)),
    )
    const input = await anyInput()
    const scripted = new ScriptedGenerator()
    const gen = new LlmGenerator({ fallback: scripted, timeoutMs: 20, fetchImpl })
    expect(await gen.next(input)).toBe(await scripted.next(input))
  })

  it('never throws, whatever the route does', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    const gen = new LlmGenerator({ fallback: new ScriptedGenerator(), fetchImpl })
    await expect(gen.next(await anyInput())).resolves.toBeTypeOf('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llmGenerator.test.ts`
Expected: FAIL — `Cannot find module '@/agents/llm'`.

- [ ] **Step 3: Write the generator**

```typescript
/**
 * The interviewers' lines, written by a model.
 *
 * It calls the app's own route rather than the provider, so the API key never
 * reaches the browser. Every failure path ends at `ScriptedGenerator`: a dead
 * key or a slow model on stage degrades to the deterministic panel rather than
 * to silence, and the demo keeps running.
 */

import type { GenerationInput, QuestionGenerator } from '@/agents'
import { buildMessages } from '@/agents/prompt'

export interface LlmGeneratorOptions {
  fallback: QuestionGenerator
  timeoutMs?: number
  endpoint?: string
  fetchImpl?: typeof fetch
}

export class LlmGenerator implements QuestionGenerator {
  private readonly fallback: QuestionGenerator
  private readonly timeoutMs: number
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor({ fallback, timeoutMs = 4000, endpoint = '/api/interviewer', fetchImpl = fetch }: LlmGeneratorOptions) {
    this.fallback = fallback
    this.timeoutMs = timeoutMs
    this.endpoint = endpoint
    this.fetchImpl = fetchImpl
  }

  async next(input: GenerationInput): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: buildMessages(input) }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const body = (await res.json()) as { text?: string }
      const text = body.text?.trim()
      if (!text) throw new Error('empty line')
      return text
    } catch {
      // Deliberately silent. A visible error mid-interview is worse than a
      // slightly duller question, and the scripted line is always in character.
      return this.fallback.next(input)
    } finally {
      clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llmGenerator.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents/llm.ts tests/llmGenerator.test.ts
git commit -m "feat: add LlmGenerator with a scripted fallback"
```

---

### Task 6: The route, and choosing a generator

**Files:**
- Create: `src/app/api/interviewer/route.ts`
- Create: `src/agents/choose.ts`
- Test: `tests/chooseGenerator.test.ts`
- Modify: `src/app/page.tsx` — imports, the join effect, and `runWholeDemo`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `requestCompletion` (Task 4), `LlmGenerator` (Task 5), `ScriptedGenerator`.
- Produces: `chooseGenerator(configured: boolean): QuestionGenerator`; `GET /api/interviewer` → `{ configured: boolean }`; `POST /api/interviewer` `{ messages }` → `{ text }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest'
import { ScriptedGenerator } from '@/agents'
import { LlmGenerator } from '@/agents/llm'
import { chooseGenerator } from '@/agents/choose'

describe('which brain drives the panel', () => {
  it('uses the model when the route reports a key', () => {
    expect(chooseGenerator(true)).toBeInstanceOf(LlmGenerator)
  })

  it('uses the scripted panel when there is no key', () => {
    expect(chooseGenerator(false)).toBeInstanceOf(ScriptedGenerator)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chooseGenerator.test.ts`
Expected: FAIL — `Cannot find module '@/agents/choose'`.

- [ ] **Step 3: Write the selector**

```typescript
import { ScriptedGenerator, type QuestionGenerator } from '@/agents'
import { LlmGenerator } from '@/agents/llm'

/** The model when a key exists, the deterministic panel when it does not. */
export function chooseGenerator(configured: boolean): QuestionGenerator {
  return configured ? new LlmGenerator({ fallback: new ScriptedGenerator() }) : new ScriptedGenerator()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/chooseGenerator.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the route**

Create `src/app/api/interviewer/route.ts`:

```typescript
/**
 * The interviewers' brain, kept server-side.
 *
 * The browser posts assembled messages and gets one line back. The API key is
 * read here and nowhere else, so it never reaches a client component.
 */

import { NextResponse } from 'next/server'
import { requestCompletion } from '@/agents/llmClient'
import type { ChatMessage } from '@/agents/prompt'

const url = () => process.env.LLM_URL ?? 'https://api.openai.com/v1/chat/completions'
const model = () => process.env.LLM_MODEL ?? 'gpt-4o-mini'

export async function GET() {
  return NextResponse.json({ configured: Boolean(process.env.LLM_API_KEY) })
}

export async function POST(request: Request) {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'No LLM_API_KEY. Running on the scripted panel.' }, { status: 200 })
  }

  try {
    const { messages } = (await request.json()) as { messages: ChatMessage[] }
    const text = await requestCompletion(messages, { url: url(), apiKey, model: model() })
    return NextResponse.json({ text })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'LLM request failed.' },
      { status: 200 },
    )
  }
}
```

- [ ] **Step 6: Wire it into the page**

In `src/app/page.tsx`, add to the imports:

```typescript
import { ScriptedGenerator } from '@/agents'
import { chooseGenerator } from '@/agents/choose'
```

In the join effect (`page.tsx:68`), replace the session construction and probe for a key alongside the existing Agora probe:

```typescript
    sessionRef.current = new InterviewSession({ mode: 'coordinated' })

    fetch('/api/interviewer')
      .then((res) => res.json())
      .then((body: { configured?: boolean }) => {
        const configured = body.configured === true
        setLlmLive(configured)
        sessionRef.current?.setGenerator(chooseGenerator(configured))
      })
      .catch(() => setLlmLive(false))
```

Add `const [llmLive, setLlmLive] = useState(false)` beside the other state, and show it in the header strip next to the transport label:

```typescript
{agoraLive ? 'agora' : 'simulated'} · {llmLive ? 'live questions' : 'scripted'}
```

Add the setter to `InterviewSession` in `src/core/session.ts`:

```typescript
  /** Swap the brain. Used once at startup, and by the demo to force determinism. */
  setGenerator(generator: QuestionGenerator): void {
    this.generator = generator
  }
```

In `runWholeDemo` (`page.tsx:213`), force the scripted panel for the duration so the rehearsal is identical every time:

```typescript
    const live = sessionRef.current
    if (!live || busyRef.current) return
    const previous = live.generator
    live.setGenerator(new ScriptedGenerator())
    try {
      // ...existing loop unchanged
    } finally {
      live.setGenerator(previous)
      // ...existing finally body
    }
```

Change `private generator: QuestionGenerator` to `generator: QuestionGenerator` in `src/core/session.ts:64` so the demo can save and restore it.

- [ ] **Step 7: Document the variables**

`.env.example` already lists `LLM_API_KEY`, `LLM_URL` and `LLM_MODEL` under "The interviewers' brains". Update that comment to say what is now true:

```
# One LLM drives whichever interviewer the coordinator gave the floor to. Without
# this the deterministic ScriptedGenerator drives every question, the header reads
# "scripted", and the rehearsed demo is unaffected either way.
```

- [ ] **Step 8: Run the whole suite and build**

Run: `npx vitest run`
Expected: PASS, 54 tests — 35 existing, plus 1 (Task 1), 3 (Task 2), 5 (Task 3), 4 (Task 4), 4 (Task 5) and 2 (Task 6).

Run: `npx next build`
Expected: `✓ Compiled successfully`, TypeScript clean.

- [ ] **Step 9: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000`.
Expected: the header reads `simulated · scripted` with no key present. Type an answer, and the panel replies exactly as it does today. Add `LLM_API_KEY` to `.env.local`, restart, and the header reads `simulated · live questions`; the same answer now produces a question written for it.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/interviewer/route.ts src/agents/choose.ts src/core/session.ts src/app/page.tsx tests/ .env.example
git commit -m "feat: drive interviewer questions from the model when a key is present"
```

---

## Out of scope for this plan

**Phase 2 — Agora transport.** Browser RTC join via `agora-rtc-sdk-ng`, the transport swap in `page.tsx:72`, and the two join-payload fixes (`turn_detection.mode: 'default'` → `'agora_vad'`, `asr.language` → `en-IN`). Blocked on Agora credentials.

**Phase 3 — Candidate transcripts from Agora.** Subscribing to the message channel before agents start, taking user transcripts from `onTranscriptUpdated`, and retiring `CandidateEar`. Blocked on Agora credentials.

Both get their own plans. Writing exact steps against an API that cannot be called would be fiction.
