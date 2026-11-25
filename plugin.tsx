import { definePlugin, defineView } from '@jaspers-ai/sdk'
import { z } from 'zod'
import { SEC_TABS, secSummary } from './sec.ts'
import { SecView } from './SecView.tsx'
import {
  activistFilings,
  company,
  facts,
  filings,
  form144,
  insiders,
  insiderTrades,
  search,
  subsidiaries,
} from './sources.ts'

const SecStateSchema = z.object({
  ticker: z.string().default(''),
  tab: z.enum(SEC_TABS).default('filings'),
  form: z.string().default(''),
  query: z.string().default(''),
  limit: z.number().int().min(1).max(100).default(25),
})

const SecOutputSchema = z.object({
  ticker: z.string(),
  tab: z.enum(SEC_TABS),
  query: z.string(),
  count: z.number(),
  items: z.array(
    z.object({
      date: z.string(),
      label: z.string(),
      detail: z.string(),
      url: z.string(),
    }),
  ),
})

export default definePlugin({
  id: 'sec',
  sources: {
    filings,
    facts,
    insiders,
    company,
    search,
    'insider-trades': insiderTrades,
    'form-144': form144,
    'activist-filings': activistFilings,
    subsidiaries,
  },
  views: {
    filings: defineView(SecView, {
      title: 'SEC EDGAR Filings & Insiders',
      state: SecStateSchema,
      output: SecOutputSchema,
      instructions:
        'SEC EDGAR filings, parsed Form 4 insider buys/sells, Form 144 sell notices, 13D/13G activist stakes, and full-text EDGAR search (no key needed). Set state.ticker (e.g. "NVDA") and state.tab to "filings", "insider-trades", "form-144", "activists", or "search" (with state.query for boolean full-text search across EDGAR).',
      renders: [filings, insiderTrades, form144, activistFilings, search],
      summarize: secSummary,
    }),
  },
})
