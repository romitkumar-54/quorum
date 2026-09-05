import { ScriptedGenerator, type QuestionGenerator } from '@/agents'
import { LlmGenerator } from '@/agents/llm'

/**
 * The model when a key exists, the deterministic panel when it does not.
 *
 * Kept as a function rather than an inline ternary so the choice is testable
 * without standing up the page.
 */
export function chooseGenerator(configured: boolean): QuestionGenerator {
  return configured ? new LlmGenerator({ fallback: new ScriptedGenerator() }) : new ScriptedGenerator()
}
