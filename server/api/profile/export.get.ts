import { Readable } from 'node:stream'

import { requireAuth } from '../../utils/auth-guard'
import { UserUniverseCollector } from '../../utils/data-management/collector'
import { prisma } from '../../utils/db'
import { createJsonStreamFromSections } from '../../utils/json-stream'

async function* createExportJsonStream(userId: string) {
  const collector = new UserUniverseCollector(prisma, userId)
  yield* createJsonStreamFromSections(collector.exportSections())
}

export default defineEventHandler(async (event) => {
  // Full account export must never be reachable with a scoped third-party
  // OAuth token: cookie session or dedicated API key only.
  const user = await requireAuth(event, undefined, { allowOAuth: false })

  // Set headers for file download
  const filename = `watts_export_${user.email.replace(/[@.]/g, '_')}_${new Date().toISOString().split('T')[0]}.json`

  setHeaders(event, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  })

  return sendStream(event, Readable.from(createExportJsonStream(user.id)))
})
