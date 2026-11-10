import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { generateStructuredAnalysis, buildWorkoutSummary } from '../server/utils/gemini'
import { prisma } from '../server/utils/db'
import { workoutRepository } from '../server/utils/repositories/workoutRepository'
import { wellnessRepository } from '../server/utils/repositories/wellnessRepository'
import { nutritionRepository } from '../server/utils/repositories/nutritionRepository'
import { sportSettingsRepository } from '../server/utils/repositories/sportSettingsRepository'
import { userReportsQueue } from './queues'
import {
  generateTrainingContext,
  formatTrainingContextForPrompt
} from '../server/utils/training-metrics'
import {
  getUserTimezone,
  getStartOfDaysAgoUTC,
  getEndOfDayUTC,
  formatUserDate,
  getUserLocalDate,
  calculateAge
} from '../server/utils/date'
import { getCheckinHistoryContext } from '../server/utils/services/checkin-service'
import { getUserAiSettings } from '../server/utils/ai-user-settings'
import { checkQuota } from '../server/utils/quotas/engine'
import { recommendTodayActivityTask } from './recommend-today-activity'
import { filterGoalsForContext } from '../server/utils/goal-context'
import { LBS_TO_KG } from '../server/utils/number'
import {
  formatPromptWeight,
  formatPromptHeight,
  formatPromptDistance
} from '../server/utils/ai-prompt-format'
import { bodyMetricResolver } from '../server/utils/services/bodyMetricResolver'

import { registerTaskHandler } from '../server/utils/task-registry'

// Athlete Profile schema for structured JSON output.
//
// Why the length wording exists (CW-368): a single runaway field — in
// production `current_fitness_explanation_json.sections[].title`, which came
// back as several hundred KB of repetitive prose — exhausts the output token
// budget, the response is cut off mid-string, and `generateObject` throws
// `AI_JSONParseError: Unterminated string in JSON`, discarding the entire
// otherwise-complete analysis. Sentry COACH-WATTS-WEB-12.
//
// READ THIS BEFORE TRUSTING `maxLength` HERE.
//
// The `maxLength` keys below are **declarative intent only — nothing enforces
// them at either end**:
//
//   1. `@ai-sdk/google` strips them before the request is sent.
//      `convertJSONSchemaToOpenAPISchema` destructures a strict allowlist
//      (`type, description, required, properties, items, allOf, anyOf, oneOf,
//      format, const, minLength, enum`). Note `minLength` is forwarded and
//      `maxLength` is not; `grep -c maxLength` over the provider's `dist/`
//      returns 0. Gemini never sees these numbers.
//   2. Nothing validates the response locally either. `generateStructuredAnalysis`
//      (`server/utils/gemini.ts`) calls `generateObject` with
//      `schema: jsonSchema(schema)` and no `validate` option, so there is no
//      post-parse length check.
//
// **The `description` text is the entire working mitigation.** The provider
// *does* forward `description`, so wording like "a heading, not a sentence or a
// paragraph (max 80 characters)" is what actually steers the model. Treat those
// strings as load-bearing prompt content: if you shorten or genericise them you
// remove the only thing standing between this task and the crash above.
//
// The `maxLength` keys are kept deliberately, as machine-readable intent, as the
// thing the schema-walk regression test pins, and so the bounds are already
// correct if/when real enforcement lands (post-parse truncation or a `validate`
// fn — tracked separately, since `generateStructuredAnalysis` is shared by ~45
// call sites). Keep them accurate; just do not mistake them for a guarantee.
//
// Limits are generous enough that a well-behaved response never bumps into them
// while still ruling out paragraph-length output in a label field.
export const athleteProfileSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['athlete_profile'],
      description: 'Type of report'
    },
    title: {
      type: 'string',
      maxLength: 120,
      description: 'Profile title — a short headline, not a sentence (max 120 characters)'
    },
    generated_date: {
      type: 'string',
      maxLength: 40,
      description: 'Date profile was generated (max 40 characters)'
    },
    executive_summary: {
      type: 'string',
      maxLength: 600,
      description:
        "2-3 sentence overview of the athlete's current status (max 600 characters, not a multi-paragraph essay)"
    },
    current_fitness: {
      type: 'object',
      description: 'Current fitness assessment',
      properties: {
        status: {
          type: 'string',
          enum: ['excellent', 'good', 'moderate', 'developing', 'recovering'],
          description: 'Overall fitness status'
        },
        status_label: {
          type: 'string',
          maxLength: 60,
          description: 'Display label for status — a few words, not a sentence (max 60 characters)'
        },
        key_points: {
          type: 'array',
          items: { type: 'string', maxLength: 300 },
          description:
            'Key fitness indicators (each as separate item, 1-2 sentences, max 300 characters per item)'
        }
      },
      required: ['status', 'status_label', 'key_points']
    },
    training_characteristics: {
      type: 'object',
      description: 'How the athlete trains',
      properties: {
        training_style: {
          type: 'string',
          maxLength: 300,
          description: 'Training approach description, 1-2 sentences (max 300 characters)'
        },
        strengths: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          description: 'Key strengths in training (max 200 characters per item)'
        },
        areas_for_development: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          description: 'Areas that need attention (max 200 characters per item)'
        }
      },
      required: ['training_style', 'strengths', 'areas_for_development']
    },
    recovery_profile: {
      type: 'object',
      description: 'Recovery patterns and trends',
      properties: {
        recovery_pattern: {
          type: 'string',
          maxLength: 300,
          description: 'Overall recovery trend, 1-2 sentences (max 300 characters)'
        },
        hrv_trend: {
          type: 'string',
          maxLength: 300,
          description: 'HRV trend analysis, 1-2 sentences (max 300 characters)'
        },
        sleep_quality: {
          type: 'string',
          maxLength: 300,
          description: 'Sleep quality assessment, 1-2 sentences (max 300 characters)'
        },
        key_observations: {
          type: 'array',
          items: { type: 'string', maxLength: 300 },
          description: 'Important recovery observations (max 300 characters per item)'
        }
      },
      required: ['recovery_pattern', 'key_observations']
    },
    nutrition_profile: {
      type: 'object',
      description: 'Nutrition patterns and adequacy',
      properties: {
        nutrition_pattern: {
          type: 'string',
          maxLength: 300,
          description: 'Overall nutrition trend and consistency, 1-2 sentences (max 300 characters)'
        },
        caloric_balance: {
          type: 'string',
          maxLength: 300,
          description:
            'Assessment of caloric intake relative to training demands, 1-2 sentences (max 300 characters)'
        },
        macro_distribution: {
          type: 'string',
          maxLength: 300,
          description: 'Protein/carbs/fat balance assessment, 1-2 sentences (max 300 characters)'
        },
        key_observations: {
          type: 'array',
          items: { type: 'string', maxLength: 300 },
          description: 'Important nutrition observations (max 300 characters per item)'
        }
      },
      required: ['nutrition_pattern', 'key_observations']
    },
    recent_performance: {
      type: 'object',
      description: 'Recent performance analysis from workout AI analysis',
      properties: {
        trend: {
          type: 'string',
          enum: ['improving', 'stable', 'declining', 'variable'],
          description: 'Performance trend'
        },
        notable_workouts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', maxLength: 40, description: 'Workout date' },
              title: {
                type: 'string',
                maxLength: 120,
                description: 'Workout title — a short label, not a sentence (max 120 characters)'
              },
              key_insight: {
                type: 'string',
                maxLength: 300,
                description: '1-2 sentence insight about the workout (max 300 characters)'
              }
            }
          },
          description: 'Highlighted workouts with insights'
        },
        patterns: {
          type: 'array',
          items: { type: 'string', maxLength: 300 },
          description: 'Performance patterns observed (max 300 characters per item)'
        }
      },
      required: ['trend', 'patterns']
    },
    recommendations_summary: {
      type: 'object',
      description: 'Summary from recent coaching recommendations',
      properties: {
        recurring_themes: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          description: 'Common themes from recent recommendations (max 200 characters per item)'
        },
        action_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              action: {
                type: 'string',
                maxLength: 300,
                description: 'A single concrete action, 1-2 sentences (max 300 characters)'
              }
            }
          },
          description: 'Prioritized action items'
        }
      },
      required: ['recurring_themes', 'action_items']
    },
    planning_context: {
      type: 'object',
      description: 'Context for workout planning',
      properties: {
        current_focus: {
          type: 'string',
          maxLength: 400,
          description: 'What should be the focus right now, 1-3 sentences (max 400 characters)'
        },
        limitations: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          description: 'Current limitations or constraints (max 200 characters per item)'
        },
        opportunities: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          description: 'Training opportunities (max 200 characters per item)'
        }
      },
      required: ['current_focus']
    },
    athlete_scores: {
      type: 'object',
      description:
        'Overall athlete profile scores on 1-10 scale for tracking development, with detailed explanations',
      properties: {
        current_fitness: {
          type: 'number',
          description: 'Current overall fitness level (1-10)',
          minimum: 1,
          maximum: 10
        },
        current_fitness_explanation: {
          type: 'string',
          maxLength: 800,
          description: 'Brief summary of current fitness level (max 800 characters)'
        },
        current_fitness_explanation_json: {
          type: 'object',
          description: 'Structured explanation of current fitness',
          properties: {
            executive_summary: {
              type: 'string',
              maxLength: 500,
              description: '2-3 sentence overview (max 500 characters)'
            },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    maxLength: 80,
                    description:
                      'Short section label of a few words, e.g. "Aerobic Base" — a heading, not a sentence or a paragraph (max 80 characters)'
                  },
                  status: {
                    type: 'string',
                    enum: ['excellent', 'good', 'moderate', 'needs_improvement']
                  },
                  analysis_points: {
                    type: 'array',
                    items: { type: 'string', maxLength: 400 },
                    description: 'Analysis points, each 1-2 sentences (max 400 characters per item)'
                  }
                }
              }
            },
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    maxLength: 80,
                    description:
                      'Short recommendation label of a few words — a heading, not a sentence or a paragraph (max 80 characters)'
                  },
                  description: {
                    type: 'string',
                    maxLength: 500,
                    description: '1-3 sentences describing the recommendation (max 500 characters)'
                  },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] }
                }
              }
            }
          },
          required: ['executive_summary', 'sections', 'recommendations']
        },
        recovery_capacity: {
          type: 'number',
          description: 'Ability to recover from training stress (1-10)',
          minimum: 1,
          maximum: 10
        },
        recovery_capacity_explanation: {
          type: 'string',
          maxLength: 800,
          description: 'Brief summary of recovery capacity (max 800 characters)'
        },
        recovery_capacity_explanation_json: {
          type: 'object',
          description: 'Structured explanation of recovery capacity',
          properties: {
            executive_summary: {
              type: 'string',
              maxLength: 500,
              description: '2-3 sentence overview (max 500 characters)'
            },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    maxLength: 80,
                    description:
                      'Short section label of a few words, e.g. "Sleep Consistency" — a heading, not a sentence or a paragraph (max 80 characters)'
                  },
                  status: {
                    type: 'string',
                    enum: ['excellent', 'good', 'moderate', 'needs_improvement']
                  },
                  analysis_points: {
                    type: 'array',
                    items: { type: 'string', maxLength: 400 },
                    description: 'Analysis points, each 1-2 sentences (max 400 characters per item)'
                  }
                }
              }
            },
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    maxLength: 80,
                    description:
                      'Short recommendation label of a few words — a heading, not a sentence or a paragraph (max 80 characters)'
                  },
                  description: {
                    type: 'string',
                    maxLength: 500,
                    description: '1-3 sentences describing the recommendation (max 500 characters)'
                  },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] }
                }
              }
            }
          },
          required: ['executive_summary', 'sections', 'recommendations']
        },
        nutrition_compliance: {
          type: 'number',
          description: 'Nutrition adherence and quality (1-10)',
          minimum: 1,
          maximum: 10
        },
        nutrition_compliance_explanation: {
          type: 'string',
          maxLength: 800,
          description:
            "Detailed explanation of nutrition quality: calorie adherence patterns, macro balance, meal timing, and specific improvements needed (e.g., 'Increase protein to 2g/kg', 'Improve pre-workout carb intake'). A few sentences, max 800 characters"
        },
        training_consistency: {
          type: 'number',
          description: 'Training consistency and adherence (1-10)',
          minimum: 1,
          maximum: 10
        },
        training_consistency_explanation: {
          type: 'string',
          maxLength: 800,
          description:
            "Detailed explanation of training consistency: weekly adherence patterns, missed sessions analysis, and strategies for improvement (e.g., 'Set specific training times', 'Prepare gear night before'). A few sentences, max 800 characters"
        },
        hr_power_alignment: {
          type: 'number',
          description: 'How well do power and HR zones match? (1-10)',
          minimum: 1,
          maximum: 10
        },
        hr_power_alignment_explanation: {
          type: 'string',
          maxLength: 800,
          description:
            "Detailed explanation of HR/Power alignment: analysis of decoupling, HR drift in different activities, and zone correlation (e.g., 'Significant decoupling on long rides', 'MTB power surges not reflected in HR'). A few sentences, max 800 characters"
        }
      },
      required: [
        'current_fitness',
        'current_fitness_explanation',
        'recovery_capacity',
        'recovery_capacity_explanation',
        'nutrition_compliance',
        'nutrition_compliance_explanation',
        'training_consistency',
        'training_consistency_explanation',
        'hr_power_alignment',
        'hr_power_alignment_explanation'
      ]
    }
  },
  required: [
    'type',
    'title',
    'generated_date',
    'executive_summary',
    'current_fitness',
    'training_characteristics',
    'recent_performance',
    'planning_context',
    'athlete_scores'
  ]
}

export async function runGenerateAthleteProfile(payload: { userId: string; reportId: string }) {
  const { userId, reportId } = payload

  logger.log('Starting athlete profile generation', { userId, reportId })

  // Check Quota
  try {
    await checkQuota(userId, 'athlete_profile_generation')
  } catch (quotaError: any) {
    if (quotaError.statusCode === 429) {
      logger.warn('Athlete profile generation quota exceeded', { userId, reportId })
      await prisma.report.update({
        where: { id: reportId },
        data: { status: 'FAILED' } // We could add a statusReason field later
      })
      return { success: false, reason: 'QUOTA_EXCEEDED' }
    }
    throw quotaError
  }

  // Update report status
  await prisma.report.update({
    where: { id: reportId },
    data: { status: 'PROCESSING' }
  })

  try {
    const aiSettings = await getUserAiSettings(userId)
    const timezone = await getUserTimezone(userId)
    const now = new Date() // Current system time for "now" queries if needed, but better to use range end
    const todayEnd = getEndOfDayUTC(timezone, now)
    const thirtyDaysAgo = getStartOfDaysAgoUTC(timezone, 30)
    const sevenDaysAgo = getStartOfDaysAgoUTC(timezone, 7)

    logger.log('Fetching comprehensive athlete data', { timezone, thirtyDaysAgo, todayEnd })

    // Fetch all relevant data
    const [
      user,
      recentWorkouts,
      recentWellness,
      recentNutrition,
      recentReports,
      recentRecommendations,
      rawActiveGoals,
      currentPlan,
      sportSettings
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          ftp: true,
          weight: true,
          weightUnits: true,
          weightSourceMode: true,
          height: true,
          heightUnits: true,
          maxHr: true,
          dob: true,
          lthr: true,
          sex: true,
          language: true,
          distanceUnits: true
        }
      }),
      workoutRepository.getForUser(userId, {
        startDate: thirtyDaysAgo,
        endDate: todayEnd,
        limit: 20,
        orderBy: { date: 'desc' },
        includeDuplicates: false,
        select: {
          id: true,
          date: true,
          title: true,
          type: true,
          durationSec: true,
          tss: true,
          averageWatts: true,
          aiAnalysisJson: true,
          streams: {
            select: {
              hrZoneTimes: true,
              powerZoneTimes: true
            }
          }
        }
      }),
      wellnessRepository.getForUser(userId, {
        startDate: thirtyDaysAgo,
        endDate: todayEnd,
        limit: 30,
        orderBy: { date: 'desc' }
      }),
      nutritionRepository.getForUser(userId, {
        startDate: sevenDaysAgo,
        endDate: todayEnd,
        limit: 14,
        orderBy: { date: 'desc' },
        select: {
          id: true,
          date: true,
          calories: true,
          protein: true,
          carbs: true,
          fat: true,
          fiber: true,
          caloriesGoal: true,
          proteinGoal: true,
          carbsGoal: true,
          fatGoal: true
        }
      }),
      prisma.report.findMany({
        where: {
          userId,
          status: 'COMPLETED',
          createdAt: { gte: thirtyDaysAgo }
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          type: true,
          createdAt: true,
          analysisJson: true,
          suggestions: true
        }
      }),
      prisma.activityRecommendation.findMany({
        where: {
          userId,
          status: 'COMPLETED',
          date: { gte: sevenDaysAgo }
        },
        orderBy: { date: 'desc' },
        take: 7,
        select: {
          date: true,
          recommendation: true,
          reasoning: true,
          analysisJson: true
        }
      }),
      // Fetch active goals
      prisma.goal.findMany({
        where: {
          userId,
          status: 'ACTIVE'
        }
      }),
      // Fetch current active plan
      prisma.weeklyTrainingPlan.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          weekStartDate: {
            lte: todayEnd
          },
          weekEndDate: {
            gte: thirtyDaysAgo // Ensure overlap
          }
        },
        orderBy: { weekStartDate: 'desc' },
        select: {
          totalTSS: true,
          planJson: true
        }
      }),
      // Fetch Sport Settings
      sportSettingsRepository.getByUserId(userId)
    ])
    const activeGoals = filterGoalsForContext(rawActiveGoals, timezone, todayEnd)

    const userAge = calculateAge(user?.dob)

    logger.log('Data fetched', {
      workoutsWithAI: recentWorkouts.length,
      wellnessRecords: recentWellness.length,
      reportsCount: recentReports.length,
      recommendationsCount: recentRecommendations.length,
      activeGoals: activeGoals.length,
      sportProfiles: sportSettings.length
    })

    // Build Multi-Sport Zone Definitions
    let sportSettingsContext = '\nSPORT SPECIFIC SETTINGS & ZONES:\n'
    for (const s of sportSettings) {
      const typeLabel = s.isDefault ? 'Fallback/Generic' : s.types.join(', ')
      sportSettingsContext += `### Profile: ${s.name || (s.isDefault ? 'Default' : 'Sport')} (${typeLabel})\n`
      sportSettingsContext += `- FTP: ${s.ftp || 'N/A'}W, LTHR: ${s.lthr || 'N/A'}bpm, MaxHR: ${s.maxHr || 'N/A'}bpm\n`
      if (s.loadPreference) {
        sportSettingsContext += `- Preferred Metric: ${s.loadPreference}\n`
      }

      if (s.hrZones && Array.isArray(s.hrZones)) {
        sportSettingsContext += `  - Heart Rate Zones: ${s.hrZones.map((z: any) => `${z.name}(${z.min}-${z.max})`).join(', ')}\n`
      }
      if (s.powerZones && Array.isArray(s.powerZones)) {
        sportSettingsContext += `  - Power Zones: ${s.powerZones.map((z: any) => `${z.name}(${z.min}-${z.max})`).join(', ')}\n`
      }
      sportSettingsContext += '\n'
    }

    // Build workout insights from AI analysis
    const workoutInsights = recentWorkouts
      .filter((w) => w.aiAnalysisJson)
      .map((w) => {
        const analysis = w.aiAnalysisJson as any
        return `${formatUserDate(w.date, timezone)}: ${w.title} - ${analysis.quick_take || analysis.executive_summary || 'Analysis available'}`
      })
      .slice(0, 10)
      .join('\n')

    // Build wellness summary
    const avgRecovery =
      recentWellness.length > 0
        ? recentWellness.reduce((sum, w) => sum + (w.recoveryScore || 50), 0) /
          recentWellness.length
        : null
    const avgHRV =
      recentWellness.length > 0
        ? recentWellness.filter((w) => w.hrv).reduce((sum, w) => sum + (w.hrv || 0), 0) /
          recentWellness.filter((w) => w.hrv).length
        : null
    const avgHRVSdnn =
      recentWellness.length > 0
        ? recentWellness.filter((w) => w.hrvSdnn).reduce((sum, w) => sum + (w.hrvSdnn || 0), 0) /
          recentWellness.filter((w) => w.hrvSdnn).length
        : null

    const wellnessSummary = `Average Recovery: ${avgRecovery ? avgRecovery.toFixed(0) + '%' : 'N/A'}
Average HRV (rMSSD): ${avgHRV ? avgHRV.toFixed(0) + ' ms' : 'N/A'}
Average HRV (SDNN): ${avgHRVSdnn ? avgHRVSdnn.toFixed(0) + ' ms' : 'N/A'}
Recent sleep: ${recentWellness
      .slice(0, 7)
      .map((w) => `${w.sleepHours?.toFixed(1) || 'N/A'}h`)
      .join(', ')}`

    // Build Wellness Analysis History
    const wellnessAnalyses = recentWellness
      .filter((w) => w.aiAnalysisJson)
      .map((w) => {
        const analysis = w.aiAnalysisJson as any
        const status = analysis.status ? `[${analysis.status.toUpperCase()}]` : ''
        const summary = analysis.executive_summary || 'Analysis available'
        return `${formatUserDate(w.date, timezone)}: ${status} ${summary}`
      })
      .slice(0, 10) // Limit to 10 most recent
      .join('\n')

    const wellnessAnalysisSummary =
      wellnessAnalyses.length > 0
        ? `\n\nWELLNESS ANALYSIS HISTORY (Recent insights):\n${wellnessAnalyses}`
        : ''

    // Build recent recommendations summary
    const recommendationsSummary = recentRecommendations
      .map(
        (r) =>
          `${formatUserDate(r.date, timezone)}: ${r.recommendation.toUpperCase()} - ${r.reasoning}`
      )
      .join('\n')

    // Build recent reports summary
    const reportsSummary = recentReports
      .map((r) => {
        const json = r.analysisJson as any
        return `${r.type}: ${json?.executive_summary || 'Analysis completed'}`
      })
      .join('\n\n')

    // Build goals summary
    const goalsSummary =
      activeGoals.length > 0
        ? activeGoals
            .map((g) => {
              const daysToTarget = g.targetDate
                ? Math.ceil((new Date(g.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                : null
              const daysToEvent = g.eventDate
                ? Math.ceil((new Date(g.eventDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
                : null

              let goalInfo = `[${g.priority}] ${g.title} (${g.type})`
              if (g.description) goalInfo += `\n  Description: ${g.description}`
              if (g.metric && g.targetValue) {
                goalInfo += `\n  Target: ${g.metric} = ${g.targetValue}`
                if (g.currentValue)
                  goalInfo += ` (Current: ${g.currentValue}, Start: ${g.startValue || 'N/A'})`
              }
              if (daysToTarget) goalInfo += `\n  Timeline: ${daysToTarget} days remaining`
              if (g.eventDate)
                goalInfo += `\n  Event: ${g.eventType || 'race'} on ${formatUserDate(g.eventDate, timezone)} (${daysToEvent} days)`
              if (g.aiContext) goalInfo += `\n  Context: ${g.aiContext}`

              return goalInfo
            })
            .join('\n\n')
        : 'No active goals set'

    // Build current plan summary
    let currentPlanSummary = 'No active weekly plan.'
    if (currentPlan) {
      const planData = currentPlan.planJson as any
      currentPlanSummary = `
Active Plan TSS Target: ${currentPlan.totalTSS || planData.totalTSS || 'N/A'}
Plan Summary: ${planData.weekSummary || 'N/A'}
`
    }

    // Build Daily Check-in Summary
    const checkinHistory = await getCheckinHistoryContext(
      userId,
      thirtyDaysAgo,
      now, // Use 'now' or 'todayEnd' as end date
      timezone
    )

    const checkinsSummary = checkinHistory
      ? `\nDAILY CHECK-INS (Subjective Feedback):\n${checkinHistory}`
      : 'No recent check-ins'

    if (checkinHistory) {
      logger.log('Check-ins Summary for Profile Prompt', { checkinHistory })
    }

    // Calculate training stats
    const totalTSS = recentWorkouts.reduce((sum, w) => sum + (w.tss || 0), 0)
    const avgWorkoutDuration =
      recentWorkouts.length > 0
        ? recentWorkouts.reduce((sum, w) => sum + w.durationSec, 0) / recentWorkouts.length / 60
        : 0

    // Generate comprehensive training context with advanced metrics
    logger.log('Generating comprehensive training context')
    const trainingContext = await generateTrainingContext(userId, thirtyDaysAgo, todayEnd, {
      includeZones: true,
      period: 'Last 30 Days',
      timezone,
      adjustForTodayUncompletedPlannedTSS: true
    })
    const formattedContext = formatTrainingContextForPrompt(trainingContext)

    logger.log('Training context generated', {
      workoutCount: trainingContext.summary.totalWorkouts,
      totalTSS: trainingContext.summary.totalTSS,
      currentCTL: trainingContext.loadTrend.currentCTL,
      currentTSB: trainingContext.loadTrend.currentTSB,
      hasZoneData: !!trainingContext.hrZoneDistribution,
      hasCurrentPlan: !!currentPlan
    })
    const effectiveWeight = await bodyMetricResolver.resolveEffectiveWeight(userId, {
      weight: user?.weight,
      weightSourceMode: user?.weightSourceMode,
      weightUnits: user?.weightUnits
    })

    // Build comprehensive prompt
    const prompt = `You are a **${aiSettings.aiPersona}** expert coach creating a comprehensive Athlete Profile for training planning purposes.
Analyze all available data to create a complete picture of this athlete.
Adapt your analysis tone and insights to match your **${aiSettings.aiPersona}** persona.

USER PROFILE:
- Age: ${userAge || 'Unknown'}
- Sex: ${user?.sex || 'Unknown'}
- Height: ${formatPromptHeight(user?.height, user?.heightUnits)}
- FTP: ${user?.ftp || 'Unknown'} watts
- Weight: ${formatPromptWeight(effectiveWeight.value, user?.weightUnits)}
- W/kg: ${user?.ftp && effectiveWeight.value ? (user.ftp / effectiveWeight.value).toFixed(2) : 'Unknown'}
- Max HR: ${user?.maxHr || 'Unknown'} bpm
- Preferred Language: ${user?.language || 'English'} (CRITICAL: ALL analysis, summaries, reasoning, and scores explanations MUST be written in this language)

${aiSettings.aiContext ? `USER PROVIDED CONTEXT / ABOUT ME / SPECIAL INSTRUCTIONS:\n${aiSettings.aiContext}\n` : ''}

${formattedContext}

${sportSettingsContext}

WORKOUT INSIGHTS (from AI analysis):
${workoutInsights || 'No detailed workout analysis available'}

RECENT TRAINING DETAILS (Last 20 sessions):
${buildWorkoutSummary(recentWorkouts, timezone, user?.distanceUnits)}

RECOVERY METRICS:
${wellnessSummary}${wellnessAnalysisSummary}

DAILY CHECK-INS (Subjective Feedback):
${checkinsSummary}

RECENT COACHING RECOMMENDATIONS (Last 7 days):
${recommendationsSummary || 'No recent recommendations'}

RECENT REPORTS & ANALYSIS:
${reportsSummary || 'No recent reports'}

CURRENT TRAINING PLAN:
${currentPlanSummary}

CURRENT GOALS:
${goalsSummary}

INSTRUCTIONS:
Create a comprehensive athlete profile that synthesizes all this data. This profile will be used for:
1. Planning future workouts
2. Understanding the athlete's current capabilities and limitations
3. Identifying patterns and trends
4. Making informed coaching decisions

**CRITICAL: Metric Prioritization**
- **Sport-Specific Settings**: ALWAYS use the FTP, LTHR, and Zones defined in the "SPORT SPECIFIC SETTINGS" section for the relevant activity type (e.g., use Running settings for runs). These override the global "USER PROFILE" values which may be outdated or generic.
- **Preferred Metrics**: If a sport profile specifies a "Preferred Metric" (e.g., HR_POWER_PACE), prioritize that data stream when analyzing intensity. For example, if "HR" is preferred, judge intensity by Heart Rate Zones even if Power is present.

Focus on:
- Current fitness state (not historical achievements, but current capability)
- Training patterns and how the athlete responds to different stimuli
- Recovery patterns and how well they handle training load
- Recent performance trends from workout analysis
- Key themes from recent recommendations
- **Current goals and their feasibility** given the athlete's current state
- **Current Plan Adherence**: How well is the athlete following the current plan? Are they meeting TSS targets?
- **Dual Intensity View**: Compare/contrast power vs HR distributions. Flag discrepancies (e.g., "74% Endurance power but only 60% Z2 HR -> HR drift in MTB")
- **HR-Specific Patterns**: Analyze drift, recovery HR drops between intervals, run vs bike differences
- **Zone Feasibility**: Assess if distributions support goals (e.g., "0% Z4 HR time blocks FTP progress")

Finally, provide **Athlete Profile Scores** (1-10 scale for tracking long-term development):
- **Current Fitness**: Overall fitness level based on recent training, FTP, and performance
- **Recovery Capacity**: How well they recover from training stress (HRV rMSSD, sleep, subjective metrics)
- **Nutrition Compliance**: Overall nutrition quality and adherence (if nutrition data available)
- **Training Consistency**: Adherence to training plans and consistency over time
- **HR/Power Alignment**: How well do power and HR zones match? (Critical for mixed-sport athletes).
  - 9-10: Perfect correlation across modalities
  - 5-6: Moderate drift but usable
  - 1-2: Significant mismatch (e.g., MTB power surges without HR response)

Scoring Guidelines:
- 9-10: Elite level in this aspect
- 7-8: Strong, well-developed
- 5-6: Average, developing
- 3-4: Needs attention and improvement
- 1-2: Significant weakness requiring focus

Be specific, data-driven, and actionable. Reference actual metrics and patterns observed. Scores should reflect realistic assessment for long-term tracking.
Maintain your **${aiSettings.aiPersona}** persona throughout.`

    logger.log('Generating athlete profile with Gemini')

    // Generate structured profile
    const profileJson = await generateStructuredAnalysis<any>(
      prompt,
      athleteProfileSchema,
      aiSettings.aiModelPreference,
      {
        userId,
        operation: 'athlete_profile_generation',
        entityType: 'Report',
        entityId: reportId
      }
    )

    logger.log('Athlete profile generated successfully', {
      scores: profileJson.athlete_scores
    })

    // Save profile as a report and update user scores
    await prisma.$transaction(async (tx) => {
      // Verify report still exists
      const currentReport = await tx.report.findUnique({
        where: { id: reportId },
        select: { id: true }
      })

      if (!currentReport) {
        logger.warn('Report was deleted during generation, skipping persistence', { reportId })
        return
      }

      // Update the report with profile data
      await tx.report.update({
        where: { id: reportId },
        data: {
          status: 'COMPLETED',
          type: 'ATHLETE_PROFILE',
          analysisJson: profileJson as any,
          modelVersion: aiSettings.aiModelPreference,
          dateRangeStart: thirtyDaysAgo,
          dateRangeEnd: now
        }
      })

      // Update user profile scores and explanations for easy access
      await tx.user.update({
        where: { id: userId },
        data: {
          currentFitnessScore: profileJson.athlete_scores?.current_fitness,
          recoveryCapacityScore: profileJson.athlete_scores?.recovery_capacity,
          nutritionComplianceScore: profileJson.athlete_scores?.nutrition_compliance,
          trainingConsistencyScore: profileJson.athlete_scores?.training_consistency,
          currentFitnessExplanation: profileJson.athlete_scores?.current_fitness_explanation,
          recoveryCapacityExplanation: profileJson.athlete_scores?.recovery_capacity_explanation,
          nutritionComplianceExplanation:
            profileJson.athlete_scores?.nutrition_compliance_explanation,
          trainingConsistencyExplanation:
            profileJson.athlete_scores?.training_consistency_explanation,
          hrPowerAlignmentScore: profileJson.athlete_scores?.hr_power_alignment,
          hrPowerAlignmentExplanation: profileJson.athlete_scores?.hr_power_alignment_explanation,
          currentFitnessExplanationJson: profileJson.athlete_scores
            ?.current_fitness_explanation_json as any,
          recoveryCapacityExplanationJson: profileJson.athlete_scores
            ?.recovery_capacity_explanation_json as any,
          nutritionComplianceExplanationJson: profileJson.athlete_scores
            ?.nutrition_compliance_explanation_json as any,
          trainingConsistencyExplanationJson: profileJson.athlete_scores
            ?.training_consistency_explanation_json as any,
          profileLastUpdated: now
        }
      })
    })

    logger.log('Athlete profile and user scores saved to database')

    return {
      success: true,
      reportId,
      userId
    }
  } catch (error) {
    logger.error('Error generating athlete profile', { error })

    await prisma.report.update({
      where: { id: reportId },
      data: { status: 'FAILED' }
    })

    throw error
  }
}

registerTaskHandler('generate-athlete-profile', runGenerateAthleteProfile)

export const generateAthleteProfileTask = task({
  id: 'generate-athlete-profile',
  maxDuration: 600,
  queue: userReportsQueue,
  run: async (payload: { userId: string; reportId: string }) => {
    return runGenerateAthleteProfile(payload)
  }
})
