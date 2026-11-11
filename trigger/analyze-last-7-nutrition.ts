import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { generateStructuredAnalysis } from '../server/utils/gemini'
import { prisma } from '../server/utils/db'
import { nutritionRepository } from '../server/utils/repositories/nutritionRepository'
import { userReportsQueue } from './queues'
import {
  getUserTimezone,
  formatUserDate,
  formatDateUTC,
  getStartOfDaysAgoUTC
} from '../server/utils/date'
import { formatPromptWeight } from '../server/utils/ai-prompt-format'

// Analysis schema for nutrition reports
const nutritionAnalysisSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description: 'Type of analysis: nutrition_analysis',
      enum: ['nutrition_analysis']
    },
    title: {
      type: 'string',
      description: 'Title of the analysis'
    },
    date: {
      type: 'string',
      description: 'Date or date range of the analysis'
    },
    executive_summary: {
      type: 'string',
      description: '2-3 sentence high-level summary of nutritional patterns and key findings'
    },
    sections: {
      type: 'array',
      description: 'Nutrition analysis sections with status and points',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Section title (e.g., Caloric Balance, Macronutrient Distribution, Weekly Patterns)'
          },
          status: {
            type: 'string',
            description: 'Overall assessment',
            enum: ['excellent', 'good', 'moderate', 'needs_improvement', 'poor']
          },
          status_label: {
            type: 'string',
            description: 'Display label for status'
          },
          analysis_points: {
            type: 'array',
            description:
              'Detailed analysis points for this section. Each point should be 1-2 sentences maximum as a separate array item.',
            items: {
              type: 'string'
            }
          }
        },
        required: ['title', 'status', 'status_label', 'analysis_points']
      }
    },
    recommendations: {
      type: 'array',
      description: 'Actionable nutrition recommendations',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Recommendation title'
          },
          priority: {
            type: 'string',
            description: 'Priority level',
            enum: ['high', 'medium', 'low']
          },
          description: {
            type: 'string',
            description: 'Detailed recommendation'
          }
        },
        required: ['title', 'priority', 'description']
      }
    },
    nutrition_summary: {
      type: 'object',
      description: 'Key nutrition metrics across the period',
      properties: {
        avg_calories: { type: 'number' },
        avg_protein: { type: 'number' },
        avg_carbs: { type: 'number' },
        avg_fat: { type: 'number' },
        avg_fiber: { type: 'number' },
        calories_vs_goal_pct: { type: 'number' },
        protein_vs_goal_pct: { type: 'number' },
        consistency_score: { type: 'number' }
      }
    }
  },
  required: ['type', 'title', 'executive_summary', 'sections']
}

function buildNutritionSummary(nutritionDays: any[], timezone: string) {
  return nutritionDays
    .map((day, idx) => {
      const dayNum = nutritionDays.length - idx
      const dateStr = formatDateUTC(day.date, 'EEE, MMM d')

      return `Day ${dayNum} (${dateStr}):
- Calories: ${day.calories || 'N/A'}${day.caloriesGoal ? ` / ${day.caloriesGoal} goal` : ''} (${day.caloriesGoal && day.calories ? Math.round((day.calories / day.caloriesGoal) * 100) + '%' : 'N/A'})
- Protein: ${day.protein || 'N/A'}g${day.proteinGoal ? ` / ${day.proteinGoal}g goal` : ''} (${day.proteinGoal && day.protein ? Math.round((day.protein / day.proteinGoal) * 100) + '%' : 'N/A'})
- Carbs: ${day.carbs || 'N/A'}g${day.carbsGoal ? ` / ${day.carbsGoal}g goal` : ''}
- Fat: ${day.fat || 'N/A'}g${day.fatGoal ? ` / ${day.fatGoal}g goal` : ''}
- Fiber: ${day.fiber || 'N/A'}g
- Water: ${day.waterMl ? `${day.waterMl}ml` : 'Not tracked'}`
    })
    .join('\n\n')
}

export function buildAnalysisPrompt(nutritionDays: any[], user: any, timezone: string) {
  const dateRange =
    nutritionDays.length > 0
      ? `${formatDateUTC(nutritionDays[nutritionDays.length - 1].date)} - ${formatDateUTC(nutritionDays[0].date)}`
      : 'Unknown'

  return `You are a friendly, supportive nutrition coach analyzing your athlete's weekly dietary intake.
Preferred Language: ${user?.language || 'English'} (ALL analysis and text responses MUST be in this language)

USER PROFILE:
- FTP: ${user?.ftp || 'Unknown'} watts
- Weight: ${formatPromptWeight(user?.weight, user?.weightUnits)}
- Cycling athlete - endurance training focus

WEEKLY NUTRITION DATA (Last ${nutritionDays.length} Days):
${buildNutritionSummary(nutritionDays, timezone)}

ANALYSIS FOCUS:
1. **Weekly Caloric Balance**: Overall energy intake trends across the week - consistency and adequacy
2. **Macronutrient Distribution**: Is the protein/carbs/fat balance appropriate and consistent for an endurance athlete?
3. **Protein Consistency**: Daily protein intake patterns - meeting recovery needs consistently?
4. **Carbohydrate Patterns**: Fueling patterns throughout the week - matching training demands?
5. **Weekly Trends**: Day-to-day variability, weekend vs weekday patterns, areas of consistency or inconsistency
6. **Hydration Habits**: Water intake patterns across the week
7. **Goal Achievement**: How well are nutrition goals being met over the week?

IMPORTANT FORMATTING RULES:
- Keep each analysis_point to 1-2 sentences maximum as a separate array item
- Do NOT combine multiple insights into one paragraph block
- Each point should be concise and specific
- Use a friendly, supportive coaching tone
- Be encouraging while providing honest feedback
- Reference specific numbers, trends, and patterns from the data
- Highlight both consistent positive habits and areas for improvement

OUTPUT: Generate a structured JSON analysis with:
- Type: "nutrition_analysis"
- Title describing the analysis period
- Executive summary (2-3 sentences with key nutritional insights from the week)
- Sections analyzing different aspects (5-7 sections covering weekly patterns)
- Specific, actionable recommendations (3-5 items)
- Nutrition summary with weekly aggregate data and consistency metrics

Be specific with numbers and weekly trends. Highlight patterns, consistency, and opportunities for improvement.`
}

function convertStructuredToMarkdown(analysis: any): string {
  let markdown = `# ${analysis.title}\n\n`
  markdown += `**Period**: ${analysis.date}\n\n`
  markdown += `## Quick Take\n\n${analysis.executive_summary}\n\n`

  if (analysis.sections && analysis.sections.length > 0) {
    markdown += `## Detailed Analysis\n\n`
    for (const section of analysis.sections) {
      markdown += `### ${section.title}\n\n`
      markdown += `**Status**: ${section.status_label}\n\n`
      if (section.analysis_points && section.analysis_points.length > 0) {
        for (const point of section.analysis_points) {
          markdown += `- ${point}\n`
        }
        markdown += '\n'
      }
    }
  }

  if (analysis.recommendations && analysis.recommendations.length > 0) {
    markdown += `## Recommendations\n\n`
    for (const rec of analysis.recommendations) {
      markdown += `### ${rec.title} (${rec.priority} priority)\n\n`
      markdown += `${rec.description}\n\n`
    }
  }

  if (analysis.nutrition_summary) {
    markdown += `## Nutrition Summary\n\n`
    const metrics = analysis.nutrition_summary
    if (metrics.avg_calories)
      markdown += `- **Average Calories**: ${Math.round(metrics.avg_calories)}\n`
    if (metrics.avg_protein)
      markdown += `- **Average Protein**: ${metrics.avg_protein.toFixed(1)}g\n`
    if (metrics.avg_carbs) markdown += `- **Average Carbs**: ${metrics.avg_carbs.toFixed(1)}g\n`
    if (metrics.avg_fat) markdown += `- **Average Fat**: ${metrics.avg_fat.toFixed(1)}g\n`
    if (metrics.avg_fiber) markdown += `- **Average Fiber**: ${metrics.avg_fiber.toFixed(1)}g\n`
    if (metrics.calories_vs_goal_pct)
      markdown += `- **Calories vs Goal**: ${metrics.calories_vs_goal_pct.toFixed(0)}%\n`
    if (metrics.protein_vs_goal_pct)
      markdown += `- **Protein vs Goal**: ${metrics.protein_vs_goal_pct.toFixed(0)}%\n`
    if (metrics.consistency_score)
      markdown += `- **Consistency Score**: ${metrics.consistency_score.toFixed(0)}%\n`
  }

  return markdown
}

export const analyzeLast7NutritionTask = task({
  id: 'analyze-last-7-nutrition',
  maxDuration: 300, // 5 minutes for AI processing
  queue: userReportsQueue,
  run: async (payload: { userId: string; reportId: string }) => {
    const { userId, reportId } = payload

    logger.log('Starting Last 7 Days Nutrition analysis', { userId, reportId })

    const timezone = await getUserTimezone(userId)

    // Update report status to PROCESSING
    await prisma.report.update({
      where: { id: reportId },
      data: { status: 'PROCESSING' }
    })

    try {
      // Calculate date range (last 7 days)
      const startDate = getStartOfDaysAgoUTC(timezone, 7)

      // Fetch nutrition data
      const recentNutrition = await nutritionRepository.getForUser(userId, {
        startDate,
        limit: 20, // Fetch a few more just in case, but filter by date
        orderBy: { date: 'desc' }
      })

      // Filter for days with calorie data and ensure we only take those >= startDate
      const nutritionDays = recentNutrition
        .filter((n) => n.calories != null && n.date >= startDate)
        .slice(0, 7) // Take up to 7 days

      if (nutritionDays.length === 0) {
        logger.warn('No nutrition data found for analysis', { userId, startDate })

        await prisma.report.update({
          where: { id: reportId },
          data: { status: 'FAILED' }
        })

        return {
          success: false,
          reason: 'No nutrition data found for the last 7 days'
        }
      }

      logger.log('Nutrition data fetched', {
        count: nutritionDays.length,
        dates: nutritionDays.map((n) => n.date)
      })

      // Fetch user profile for context
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { ftp: true, weight: true, weightUnits: true, maxHr: true, language: true }
      })

      // Build the analysis prompt
      const prompt = buildAnalysisPrompt(nutritionDays, user, timezone)

      logger.log('Generating structured nutrition analysis with Gemini')

      // Generate structured JSON analysis
      const structuredAnalysis = (await generateStructuredAnalysis(
        prompt,
        nutritionAnalysisSchema,
        'flash',
        {
          userId,
          operation: 'unified_report_generation',
          entityType: 'Nutrition',
          entityId: undefined
        }
      )) as any

      // Also generate markdown for fallback/export
      const markdownAnalysis = convertStructuredToMarkdown(structuredAnalysis)

      logger.log('Nutrition analysis generated successfully', {
        sections: structuredAnalysis.sections?.length || 0,
        recommendations: structuredAnalysis.recommendations?.length || 0
      })

      // Calculate date range from nutrition data
      const dateRangeStart = new Date(nutritionDays[nutritionDays.length - 1].date)
      const dateRangeEnd = new Date(nutritionDays[0].date)

      // Save both formats to the database and link nutrition entries
      await prisma.$transaction(async (tx) => {
        // Update the report
        await tx.report.update({
          where: { id: reportId },
          data: {
            status: 'COMPLETED',
            markdown: markdownAnalysis,
            analysisJson: structuredAnalysis as any,
            modelVersion: 'gemini-2.0-flash-thinking-exp-1219',
            dateRangeStart,
            dateRangeEnd
          }
        })

        // Link the nutrition entries to the report
        await (tx as any).reportNutrition.createMany({
          data: nutritionDays.map((nutrition) => ({
            reportId,
            nutritionId: nutrition.id
          }))
        })
      })

      logger.log('Report saved to database with nutrition links', {
        nutritionLinked: nutritionDays.length
      })

      return {
        success: true,
        reportId,
        userId,
        nutritionDaysAnalyzed: nutritionDays.length,
        analysisLength: markdownAnalysis.length,
        sectionsCount: structuredAnalysis.sections?.length || 0
      }
    } catch (error) {
      logger.error('Error generating Last 7 Days Nutrition analysis', { error })

      await prisma.report.update({
        where: { id: reportId },
        data: { status: 'FAILED' }
      })

      throw error
    }
  }
})
