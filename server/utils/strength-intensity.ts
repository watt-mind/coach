const KG_PER_LB = 0.45359237

export type StrengthHistorySet = {
  exerciseName: string
  reps: number | null
  weight: number | null
  weightUnit: string | null
  rpe?: number | null
  performedAt?: Date | string | null
  setOrder?: number | null
}

export type StrengthIntensityReference = {
  exerciseName: string
  e1rmKg: { minKg: number; maxKg: number }
  sampleCount: number
  latestRpe: number | null
  estimatedRir: number | null
  progressionAdjustment: number
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function normalizeExerciseName(value: unknown) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function weightToKg(weight: unknown, unit: unknown): number | null {
  const value = Number(weight)
  if (!Number.isFinite(value) || value <= 0) return null

  const normalizedUnit = String(unit || '')
    .trim()
    .toLowerCase()
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(normalizedUnit)) return value
  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalizedUnit)) return value * KG_PER_LB
  return null
}

/**
 * Estimate one-rep max as the spread across Epley, Brzycki, and Wathan.
 * The formulas only stay acceptably close for logged sets of eight reps or fewer.
 */
export function estimateE1rmRange(
  weightKg: number,
  reps: number
): { minKg: number; maxKg: number } | null {
  if (
    !Number.isFinite(weightKg) ||
    weightKg <= 0 ||
    !Number.isInteger(reps) ||
    reps < 1 ||
    reps > 8
  ) {
    return null
  }

  const estimates = [
    weightKg * (1 + reps / 30),
    weightKg * (36 / (37 - reps)),
    weightKg * (100 / (48.8 + 53.8 * Math.exp(-0.075 * reps)))
  ]

  return {
    minKg: round(Math.min(...estimates)),
    maxKg: round(Math.max(...estimates))
  }
}

function progressionFromRpe(rpe: number | null) {
  if (rpe === null || !Number.isFinite(rpe)) {
    return { estimatedRir: null, progressionAdjustment: 0 }
  }

  const estimatedRir = round(Math.max(0, Math.min(10, 10 - rpe)), 1)
  if (estimatedRir >= 3) return { estimatedRir, progressionAdjustment: 0.025 }
  if (estimatedRir <= 0.5) return { estimatedRir, progressionAdjustment: -0.025 }
  return { estimatedRir, progressionAdjustment: 0 }
}

export function buildStrengthIntensityReferences(
  history: StrengthHistorySet[]
): StrengthIntensityReference[] {
  const grouped = new Map<
    string,
    {
      exerciseName: string
      bestRange: { minKg: number; maxKg: number }
      bestMidpoint: number
      sampleCount: number
      latestRpe: number | null
      latestTimestamp: number
      latestSetOrder: number
    }
  >()

  history.forEach((set, index) => {
    const key = normalizeExerciseName(set.exerciseName)
    const weightKg = weightToKg(set.weight, set.weightUnit)
    const reps = Number(set.reps)
    if (!key || weightKg === null) return

    const range = estimateE1rmRange(weightKg, reps)
    if (!range) return

    const midpoint = (range.minKg + range.maxKg) / 2
    const parsedTimestamp = set.performedAt ? new Date(set.performedAt).getTime() : index
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : index
    const rpe = Number(set.rpe)
    const validRpe = Number.isFinite(rpe) && rpe >= 1 && rpe <= 10 ? rpe : null
    const parsedSetOrder = Number(set.setOrder)
    const setOrder = Number.isFinite(parsedSetOrder) ? parsedSetOrder : -1
    const current = grouped.get(key)

    if (!current) {
      grouped.set(key, {
        exerciseName: String(set.exerciseName).trim(),
        bestRange: range,
        bestMidpoint: midpoint,
        sampleCount: 1,
        latestRpe: validRpe,
        latestTimestamp: timestamp,
        latestSetOrder: setOrder
      })
      return
    }

    current.sampleCount += 1
    if (midpoint > current.bestMidpoint) {
      current.bestRange = range
      current.bestMidpoint = midpoint
    }
    if (
      timestamp > current.latestTimestamp ||
      (timestamp === current.latestTimestamp && setOrder > current.latestSetOrder)
    ) {
      current.latestTimestamp = timestamp
      current.latestSetOrder = setOrder
      current.latestRpe = validRpe
    }
  })

  return [...grouped.values()]
    .map((group) => ({
      exerciseName: group.exerciseName,
      e1rmKg: group.bestRange,
      sampleCount: group.sampleCount,
      latestRpe: group.latestRpe,
      ...progressionFromRpe(group.latestRpe)
    }))
    .sort((a, b) => a.exerciseName.localeCompare(b.exerciseName))
}

export async function loadStrengthIntensityReferences(
  client: any,
  userId: string
): Promise<StrengthIntensityReference[]> {
  const sets = await client.workoutSet.findMany({
    where: {
      reps: { gte: 1, lte: 8 },
      weight: { gt: 0 },
      workoutExercise: { workout: { userId } }
    },
    select: {
      reps: true,
      weight: true,
      weightUnit: true,
      rpe: true,
      order: true,
      workoutExercise: {
        select: {
          exercise: { select: { title: true } },
          workout: { select: { date: true } }
        }
      }
    },
    orderBy: [{ workoutExercise: { workout: { date: 'desc' } } }, { order: 'desc' }, { id: 'asc' }],
    take: 1000
  })

  return buildStrengthIntensityReferences(
    sets.map((set: any) => ({
      exerciseName: set.workoutExercise?.exercise?.title || '',
      reps: set.reps,
      weight: set.weight,
      weightUnit: set.weightUnit,
      rpe: set.rpe,
      performedAt: set.workoutExercise?.workout?.date,
      setOrder: set.order
    }))
  )
}

export function formatStrengthIntensityReferences(references: StrengthIntensityReference[]) {
  if (references.length === 0) return ''

  const rows = references.map((reference) => {
    const rpe =
      reference.latestRpe === null
        ? 'latest RPE unavailable'
        : `latest RPE ${reference.latestRpe} (estimated RIR ${reference.estimatedRir})`
    const progression =
      reference.progressionAdjustment > 0
        ? 'progress target +2.5%'
        : reference.progressionAdjustment < 0
          ? 'reduce target -2.5%'
          : 'hold target'
    return `- ${reference.exerciseName}: e1RM ${round(reference.e1rmKg.minKg, 1)}-${round(reference.e1rmKg.maxKg, 1)} kg; ${rpe}; ${progression}`
  })

  return `STRENGTH INTENSITY REFERENCES (logged sets of 1-8 reps only):
${rows.join('\n')}
Use a reference only for the same exercise. If an exercise is absent, leave its load blank rather than inventing one.`
}

function parsePlannedReps(value: unknown): number | null {
  const matches = String(value || '').match(/\d+(?:\.\d+)?/g)
  if (!matches?.length) return null
  const reps = Math.max(...matches.map(Number))
  return Number.isFinite(reps) && reps >= 1 && reps <= 20 ? reps : null
}

function roundToIncrement(value: number, increment: number) {
  return Math.max(increment, Math.round(value / increment) * increment)
}

function formatLoad(value: number) {
  return Number.isInteger(value) ? String(value) : String(round(value, 1))
}

export function applyStrengthIntensityTargets(
  structuredWorkout: any,
  references: StrengthIntensityReference[],
  preferredWeightUnits: unknown
) {
  if (!Array.isArray(structuredWorkout?.blocks) || references.length === 0) {
    return structuredWorkout
  }

  const referenceByName = new Map(
    references.map((reference) => [normalizeExerciseName(reference.exerciseName), reference])
  )
  const usePounds = String(preferredWeightUnits || '').toLowerCase() === 'pounds'

  for (const block of structuredWorkout.blocks) {
    for (const step of Array.isArray(block?.steps) ? block.steps : []) {
      const reference = referenceByName.get(normalizeExerciseName(step?.name))
      if (!reference || !Array.isArray(step?.setRows)) continue

      const existingLoadMode = String(step?.loadMode || '')
      const hasExplicitLoads = step.setRows.some((row: any) =>
        Boolean(String(row?.loadValue || '').trim())
      )
      const hasConcreteUnit = existingLoadMode === 'weight_kg' || existingLoadMode === 'weight_lb'
      if (hasExplicitLoads && !hasConcreteUnit) continue
      const stepUsesPounds = hasConcreteUnit ? existingLoadMode === 'weight_lb' : usePounds

      let filledAnyLoad = false
      for (const row of step.setRows) {
        if (String(row?.loadValue || '').trim()) continue
        const reps = parsePlannedReps(row?.value)
        if (reps === null) continue

        // Invert Epley against the conservative lower edge of the formula range,
        // then apply a small progression adjustment from the latest logged RPE/RIR.
        const repPercentage = 1 / (1 + reps / 30)
        const targetKg =
          reference.e1rmKg.minKg * repPercentage * (1 + reference.progressionAdjustment)
        const target = stepUsesPounds
          ? roundToIncrement(targetKg / KG_PER_LB, 5)
          : roundToIncrement(targetKg, 2.5)

        row.loadValue = formatLoad(target)
        filledAnyLoad = true
      }

      if (filledAnyLoad) {
        step.loadMode = stepUsesPounds ? 'weight_lb' : 'weight_kg'
      }
    }
  }

  return structuredWorkout
}
