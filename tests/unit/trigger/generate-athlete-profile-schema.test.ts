import { describe, expect, it } from 'vitest'
import { athleteProfileSchema } from '../../../trigger/generate-athlete-profile'

/**
 * Regression guard for CW-368.
 *
 * The model returned several hundred KB of run-on prose for
 * `current_fitness_explanation_json.sections[].title` — a field meant to hold a
 * short heading. The response was cut off mid-string when the output token
 * budget ran out, so `generateObject` threw
 * `AI_JSONParseError: Unterminated string in JSON` and the entire otherwise
 * complete analysis was discarded.
 *
 * SCOPE — THIS FILE TESTS DECLARATION, NOT ENFORCEMENT.
 *
 * Nothing enforces `maxLength` at runtime: `@ai-sdk/google` strips it from the
 * request (its schema converter allowlists `minLength` but not `maxLength`), and
 * `generateStructuredAnalysis` calls `generateObject` without a `validate`
 * option, so responses are never length-checked. A green run here does **not**
 * mean an over-long value is impossible — only that the schema still declares
 * the intent and still carries the conciseness wording.
 *
 * That wording is the part that actually works. The provider does forward
 * `description`, so the description assertions below cover the real mitigation;
 * the `maxLength` assertions cover machine-readable intent and forward-compat
 * for whenever real enforcement lands. See the header comment on
 * `athleteProfileSchema` for the full detail.
 */

type JsonSchemaNode = {
  type?: string
  enum?: unknown[]
  maxLength?: number
  description?: string
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
}

const schema = athleteProfileSchema as unknown as JsonSchemaNode

/** Resolve a slash-separated path through `properties` / `items`. */
function at(path: string): JsonSchemaNode {
  let node: JsonSchemaNode = schema
  for (const segment of path.split('/')) {
    const next = segment === '[]' ? node.items : node.properties?.[segment]
    expect(next, `missing schema node at "${path}" (segment "${segment}")`).toBeDefined()
    node = next as JsonSchemaNode
  }
  return node
}

/**
 * Every free-text string node in the schema, keyed by its path.
 *
 * Traverses `properties` and single-schema `items` only. It does **not** descend
 * into `anyOf` / `oneOf` / `allOf` / `$ref` / `additionalProperties` / tuple-form
 * (array) `items`. None of those appear in `athleteProfileSchema` today, so the
 * walk is currently exhaustive — but a future field added under any of them
 * would escape this guard silently. Extend the walker if you introduce one.
 */
function freeTextStrings(
  node: JsonSchemaNode,
  path = '',
  found: Array<[string, JsonSchemaNode]> = []
): Array<[string, JsonSchemaNode]> {
  if (node.type === 'string' && !node.enum) found.push([path, node])
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      freeTextStrings(child, path ? `${path}/${key}` : key, found)
    }
  }
  if (node.items) freeTextStrings(node.items, `${path}/[]`, found)
  return found
}

const explanationJsonBlocks = [
  'athlete_scores/current_fitness_explanation_json',
  'athlete_scores/recovery_capacity_explanation_json'
]

describe('athleteProfileSchema — declared free-text length intent (CW-368)', () => {
  it('declares a maxLength on every free-text string field, leaving none unbounded', () => {
    const unbounded = freeTextStrings(schema)
      .filter(([, node]) => typeof node.maxLength !== 'number')
      .map(([path]) => path)

    expect(unbounded, `free-text fields missing maxLength:\n${unbounded.join('\n')}`).toEqual([])
  })

  it.each(explanationJsonBlocks)(
    '%s declares a section-title maxLength well under 100 chars',
    (block) => {
      const title = at(`${block}/sections/[]/title`)

      expect(title.maxLength).toBeTypeOf('number')
      expect(title.maxLength).toBeLessThan(100)
      expect(title.maxLength).toBeGreaterThan(0)
    }
  )

  it.each(explanationJsonBlocks)(
    '%s tells the model a section title is a heading, not a paragraph',
    (block) => {
      const description = at(`${block}/sections/[]/title`).description ?? ''

      // This is the assertion that covers the *working* mitigation: the provider
      // forwards `description` but strips `maxLength`, so this wording is what
      // actually reaches Gemini and steers the field that failed in production.
      expect(description).toMatch(/not a sentence or a paragraph/i)
      expect(description).toMatch(/max 80 characters/i)
    }
  )

  it.each(explanationJsonBlocks)(
    '%s declares a maxLength on its other free-text fields',
    (block) => {
      expect(at(`${block}/executive_summary`).maxLength).toBe(500)
      expect(at(`${block}/sections/[]/analysis_points/[]`).maxLength).toBe(400)
      expect(at(`${block}/recommendations/[]/title`).maxLength).toBe(80)
      expect(at(`${block}/recommendations/[]/description`).maxLength).toBe(500)
    }
  )

  it('keeps short-label fields shorter than prose fields', () => {
    const sectionTitle = at('athlete_scores/current_fitness_explanation_json/sections/[]/title')
    const summary = at('athlete_scores/current_fitness_explanation_json/executive_summary')

    expect(sectionTitle.maxLength!).toBeLessThan(summary.maxLength!)
  })

  it('declares a maxLength on the top-level narrative fields too', () => {
    expect(at('title').maxLength).toBe(120)
    expect(at('executive_summary').maxLength).toBe(600)
    expect(at('current_fitness/status_label').maxLength).toBe(60)
    expect(at('current_fitness/key_points/[]').maxLength).toBe(300)
  })

  it('declares a maxLength on the flat score explanation strings', () => {
    for (const field of [
      'current_fitness_explanation',
      'recovery_capacity_explanation',
      'nutrition_compliance_explanation',
      'training_consistency_explanation',
      'hr_power_alignment_explanation'
    ]) {
      expect(at(`athlete_scores/${field}`).maxLength, field).toBe(800)
    }
  })
})
