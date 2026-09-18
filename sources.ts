import { defineSource } from '@jaspers-ai/sdk'
import { z } from 'zod'

// The published SDK types a source's arguments as unknown, since from there it cannot see the
// schema beside them. Each run names what its own input parses to.
type Args = Record<string, any>

// SEC EDGAR, straight from the source. No key and no account: the SEC asks only that a caller says
// who it is in its User-Agent and keeps under ten requests a second, and both are done here.
//
// This is the free, per-company half of SEC data: what one filer filed, what it reported, and who
// bought and sold. Screening the whole universe on those numbers is the Jaspers screener's job.

const HOSTS = ['data.sec.gov', 'www.sec.gov']
const AGENT = 'Jaspers Terminal (https://jsprai.com)'
/** The SEC's published ceiling is ten a second; this stays well under it. */
const MIN_GAP_MS = 120

let last = 0
/** Every call goes through here, so a view and the assistant asking at once still queue politely. */
async function get(ctx: { fetch: typeof fetch }, url: string): Promise<unknown> {
  const wait = Math.max(0, last + MIN_GAP_MS - Date.now())
  last = Date.now() + wait
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  const response = await ctx.fetch(url, { headers: { 'User-Agent': AGENT, Accept: 'application/json' } })
  if (!response.ok) {
    if (response.status === 404) throw new Error(`The SEC has nothing at that address. Check the ticker or the tag.`)
    throw new Error(`The SEC answered ${response.status}. It rate limits by User-Agent; try again in a moment.`)
  }
  return response.json()
}

/** ticker to CIK, from the SEC's own list, read once per host and kept. */
let tickers: Map<string, { cik: string; name: string }> | null = null

async function lookup(ctx: { fetch: typeof fetch }, symbol: string): Promise<{ cik: string; name: string }> {
  const wanted = symbol.trim().toUpperCase()
  if (/^\d{1,10}$/.test(wanted)) return { cik: wanted.padStart(10, '0'), name: wanted }
  if (!tickers) {
    const listed = (await get(ctx, 'https://www.sec.gov/files/company_tickers.json')) as Record<string, { cik_str: number; ticker: string; title: string }>
    tickers = new Map(Object.values(listed).map((one) => [one.ticker.toUpperCase(), { cik: String(one.cik_str).padStart(10, '0'), name: one.title }]))
  }
  const found = tickers.get(wanted)
  if (!found) throw new Error(`No SEC filer trades as ${wanted}. Give its ticker as EDGAR lists it, or its CIK.`)
  return found
}

const ticker = z.string().describe('A ticker like AAPL, or a CIK.')

interface Submissions {
  cik: string
  name: string
  sic: string
  sicDescription: string
  tickers: string[]
  exchanges: string[]
  category: string
  stateOfIncorporation: string
  fiscalYearEnd: string
  filings: { recent: Record<string, (string | number)[]> }
}

/** The filings table as rows, newest first, since EDGAR answers with parallel arrays. */
function rowsOf(recent: Record<string, (string | number)[]>, cik: string): Record<string, unknown>[] {
  const keys = Object.keys(recent)
  const count = recent['accessionNumber']?.length ?? 0
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {}
    for (const key of keys) row[key] = recent[key]?.[i] ?? null
    const accession = String(row['accessionNumber'] ?? '').replace(/-/g, '')
    row['url'] = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${String(row['primaryDocument'] ?? '')}`
    out.push(row)
  }
  return out
}

export const filings = defineSource({
  description:
    'Filings one company has sent to the SEC, newest first: form, date, and a link to the document. form narrows it, like 10-K, 10-Q, 8-K, or 4. This is the free per-company feed; screening every filer is the screener plugin.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    form: z.string().optional().describe('One form type, like 10-K or 8-K. Left out, every form comes back.'),
    limit: z.number().int().min(1).max(1000).default(40),
  }),
  async run(raw, ctx) {
    const { ticker: symbol, form, limit } = raw as Args
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await get(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
    let rows = rowsOf(data.filings.recent, cik)
    if (form) {
      const wanted = form.trim().toUpperCase()
      rows = rows.filter((row) => String(row['form'] ?? '').toUpperCase() === wanted)
    }
    return { company: data.name || name, cik, rows: rows.slice(0, limit) }
  },
})

export const facts = defineSource({
  description:
    'What one company reported for one XBRL tag, every period it filed, with the filing each number came from. The tag is a US GAAP name like Revenues, NetIncomeLoss, Assets, or StockholdersEquity.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    tag: z.string().default('Revenues').describe('A US GAAP tag, like NetIncomeLoss.'),
    taxonomy: z.string().default('us-gaap'),
    annual: z.boolean().default(false).describe('Only figures from 10-K filings.'),
  }),
  async run(raw, ctx) {
    const { ticker: symbol, tag, taxonomy, annual } = raw as Args
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await get(ctx, `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`)) as {
      label?: string
      units: Record<string, { start?: string; end: string; val: number; fy: number; fp: string; form: string; filed: string; frame?: string }[]>
    }
    const unit = Object.keys(data.units)[0]
    // One period is reported in several filings: the year's own 10-K, and again as the comparative
    // in the next one. The latest filing is the one that stands, since a restatement supersedes.
    const latest = new Map<string, { end: string; filed: string } & Record<string, unknown>>()
    for (const one of unit ? (data.units[unit] ?? []) : []) {
      if (annual && one.form !== '10-K') continue
      const key = `${one.start ?? ''}..${one.end}`
      const row = {
        ticker: symbol.toUpperCase(),
        end: one.end,
        start: one.start ?? null,
        value: one.val,
        unit,
        fy: one.fy,
        fp: one.fp,
        form: one.form,
        filed: one.filed,
      }
      const held = latest.get(key)
      if (!held || held.filed < one.filed) latest.set(key, row)
    }
    const rows = [...latest.values()].sort((a, b) => a.end.localeCompare(b.end))
    return { company: name, tag, label: data.label ?? tag, unit, rows }
  },
})

export const insiders = defineSource({
  description:
    'Insider forms one company filed: Form 4 as they are reported, newest first, with a link to each. Who bought or sold and how much is inside the linked form.',
  hosts: HOSTS,
  input: z.object({ ticker, limit: z.number().int().min(1).max(500).default(40) }),
  async run(raw, ctx) {
    const { ticker: symbol, limit } = raw as Args
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await get(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
    const rows = rowsOf(data.filings.recent, cik)
      .filter((row) => ['3', '4', '5'].includes(String(row['form'] ?? '')))
      .map((row) => ({ form: row['form'], filed: row['filingDate'], reported: row['reportDate'], url: row['url'] }))
      .slice(0, limit)
    return { company: data.name || name, cik, rows }
  },
})

export const company = defineSource({
  description: 'What the SEC knows about one filer: its name, CIK, tickers and exchanges, industry, state, and fiscal year end.',
  hosts: HOSTS,
  input: z.object({ ticker }),
  async run(raw, ctx) {
    const { ticker: symbol } = raw as Args
    const { cik } = await lookup(ctx, symbol)
    const data = (await get(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
    return {
      rows: [
        {
          name: data.name,
          cik: data.cik,
          tickers: (data.tickers ?? []).join(', '),
          exchanges: (data.exchanges ?? []).join(', '),
          industry: data.sicDescription,
          sic: data.sic,
          category: data.category,
          incorporated: data.stateOfIncorporation,
          fiscalYearEnd: data.fiscalYearEnd,
        },
      ],
    }
  },
})
