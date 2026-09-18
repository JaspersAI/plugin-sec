import { definePlugin } from '@jaspers-ai/sdk'
import { company, facts, filings, insiders } from './sources.ts'

export default definePlugin({
  id: 'sec',
  sources: { filings, facts, insiders, company },
  views: {},
})
