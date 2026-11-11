import { EmailDeliveryService } from '../../../../utils/services/emailDeliveryService'
import { getServerSession } from '../../../../utils/session'

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session?.user?.isAdmin) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden'
    })
  }

  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Missing ID' })
  }

  try {
    const updated = await EmailDeliveryService.dispatch(id)
    return { success: updated.status === 'SENT', data: updated }
  } catch (error: any) {
    console.error('Failed to manually send email:', error)

    throw createError({
      statusCode: error.statusCode || 500,
      statusMessage: error.message || 'Failed to send email'
    })
  }
})
