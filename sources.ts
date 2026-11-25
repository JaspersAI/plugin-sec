import { defineSource } from '@jaspers-ai/sdk'
import { z } from 'zod'
import {
  edgarDocUrl,
  normalizeEftsHits,
  parseExhibit21Html,
  parseForm4Xml,
  parseForm144Xml,
  stripXslPrefix,
  type ParsedForm4Trade,
  type ParsedForm144Notice,
} from './sec.ts'

// SEC EDGAR, straight from the source. No key and no account: the SEC asks only that a caller says
// who it is in its User-Agent and keeps under ten requests a second, and both are done here.

const HOSTS = ['data.sec.gov', 'www.sec.gov', 'efts.sec.gov']
const AGENT = 'Jaspers Terminal (https://jsprai.com)'
const MIN_GAP_MS = 120

let last = 0

async function requestSec(ctx: { fetch: typeof fetch }, url: string, accept = 'application/json'): Promise<Response> {
  const wait = Math.max(0, last + MIN_GAP_MS - Date.now())
  last = Date.now() + wait
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  const response = await ctx.fetch(url, { headers: { 'User-Agent': AGENT, Accept: accept } })
  if (!response.ok) {
    if (response.status === 404) throw new Error('The SEC has nothing at that address. Check the ticker or the tag.')
    throw new Error(`The SEC answered ${response.status}. It rate limits by User-Agent; try again in a moment.`)
  }
  return response
}

async function getJson(ctx: { fetch: typeof fetch }, url: string): Promise<unknown> {
  return (await requestSec(ctx, url, 'application/json')).json()
}

async function getText(ctx: { fetch: typeof fetch }, url: string): Promise<string> {
  return (await requestSec(ctx, url, 'application/xml, text/html, text/plain, */*')).text()
}

let tickers: Map<string, { cik: string; name: string }> | null = null

async function lookup(ctx: { fetch: typeof fetch }, symbol: string): Promise<{ cik: string; name: string }> {
  const wanted = symbol.trim().toUpperCase()
  if (/^\d{1,10}$/.test(wanted)) return { cik: wanted.padStart(10, '0'), name: wanted }
  if (!tickers) {
    const listed = (await getJson(ctx, 'https://www.sec.gov/files/company_tickers.json')) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >
    tickers = new Map(
      Object.values(listed).map((one) => [
        one.ticker.toUpperCase(),
        { cik: String(one.cik_str).padStart(10, '0'), name: one.title },
      ]),
    )
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

function rowsOf(recent: Record<string, (string | number)[]>, cik: string): Record<string, unknown>[] {
  const keys = Object.keys(recent)
  const count = recent['accessionNumber']?.length ?? 0
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {}
    for (const key of keys) row[key] = recent[key]?.[i] ?? null
    row['url'] = edgarDocUrl(cik, String(row['accessionNumber'] ?? ''), String(row['primaryDocument'] ?? ''))
    out.push(row)
  }
  return out
}

export const filings = defineSource({
  description:
    'Filings one company has sent to the SEC, newest first: form, date, and a link to the document. form narrows it, like 10-K, 10-Q, 8-K, or 4. No key needed.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    form: z.string().optional().describe('One form type, like 10-K or 8-K. Left out, every form comes back.'),
    limit: z.number().int().min(1).max(1000).default(40),
  }),
  async run({ ticker: symbol, form, limit }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await getJson(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
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
  async run({ ticker: symbol, tag, taxonomy, annual }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await getJson(
      ctx,
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`,
    )) as {
      label?: string
      units: Record<
        string,
        { start?: string; end: string; val: number; fy: number; fp: string; form: string; filed: string }[]
      >
    }
    const unit = Object.keys(data.units)[0]
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
    'Insider forms (3, 4, and 5) one company filed, newest first, with a link to each. For parsed buy/sell share counts and prices, run sec/insider-trades.',
  hosts: HOSTS,
  input: z.object({ ticker, limit: z.number().int().min(1).max(500).default(40) }),
  async run({ ticker: symbol, limit }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await getJson(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
    const rows = rowsOf(data.filings.recent, cik)
      .filter((row) => ['3', '4', '5'].includes(String(row['form'] ?? '')))
      .map((row) => ({ form: row['form'], filed: row['filingDate'], reported: row['reportDate'], url: row['url'] }))
      .slice(0, limit)
    return { company: data.name || name, cik, rows }
  },
})

export const company = defineSource({
  description:
    'What the SEC knows about one filer: its name, CIK, tickers and exchanges, industry, state, and fiscal year end.',
  hosts: HOSTS,
  input: z.object({ ticker }),
  async run({ ticker: symbol }, ctx) {
    const { cik } = await lookup(ctx, symbol)
    const data = (await getJson(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
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

export const search = defineSource({
  description:
    'Full-text boolean search across SEC EDGAR filings since 2001 (efts.sec.gov): search 8-K, 10-K, 10-Q, S-1, DEF 14A, or exhibits for phrases like "\"subpoena\"", "\"Wells notice\"", "\"going concern\"", or "\"material weakness\"", optionally scoped to a ticker/CIK, form types, SIC, and date window. No key needed.',
  hosts: HOSTS,
  input: z.object({
    query: z.string().describe('Boolean or quoted phrase query, e.g. "\"Wells notice\"" or "subpoena AND DOJ".'),
    ticker: z.string().optional().describe('Optional ticker or CIK to narrow search to one company.'),
    forms: z.string().optional().describe('Comma-separated root forms, like "8-K,10-K" or "S-1".'),
    startDate: z.string().optional().describe('Earliest filing date YYYY-MM-DD.'),
    endDate: z.string().optional().describe('Latest filing date YYYY-MM-DD.'),
    sic: z.string().optional().describe('Optional 4-digit SIC code, like "2834" (pharma) or "7372" (software).'),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  async run({ query, ticker: symbol, forms, startDate, endDate, sic, limit }, ctx) {
    const params = new URLSearchParams({ q: query, from: '0', size: String(limit) })
    if (symbol) {
      const { cik } = await lookup(ctx, symbol)
      params.set('ciks', cik)
    }
    if (forms) params.set('forms', forms)
    if (sic) params.set('sics', sic)
    if (startDate || endDate) {
      params.set('dateRange', 'custom')
      if (startDate) params.set('startdt', startDate)
      if (endDate) params.set('enddt', endDate)
    }
    const payload = (await getJson(ctx, `https://efts.sec.gov/LATEST/search-index?${params.toString()}`)) as {
      hits?: { total?: { value?: number }; hits?: Record<string, unknown>[] }
    }
    const rawHits = payload.hits?.hits ?? []
    const rows = normalizeEftsHits(rawHits).sort((a, b) => b.filed.localeCompare(a.filed))
    return { totalHits: payload.hits?.total?.value ?? rows.length, rows }
  },
})

export const insiderTrades = defineSource({
  description:
    'Parses a company’s latest Form 4 XML filings into structured insider buy/sell rows: insider name, officer title, transaction date, code (P = Open-Market Buy, S = Sale, M = Exercise, F = Tax), shares, price, dollar value, shares owned after, and Rule 10b5-1 trading-plan flag. No key needed.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    filingsToParse: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe('How many of the newest Form 4 filings to fetch and parse.'),
    openMarketOnly: z
      .boolean()
      .default(false)
      .describe('When true, keep only open-market purchases (P) and sales (S), filtering out grants and tax withholdings.'),
  }),
  async run({ ticker: symbol, filingsToParse, openMarketOnly }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await getJson(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
    const form4s = rowsOf(data.filings.recent, cik)
      .filter((row) => String(row['form'] ?? '') === '4')
      .slice(0, filingsToParse)
    const rows: ParsedForm4Trade[] = []
    for (const f of form4s) {
      const accession = String(f['accessionNumber'] ?? '')
      const primaryDoc = stripXslPrefix(String(f['primaryDocument'] ?? ''))
      if (!accession || !primaryDoc.endsWith('.xml')) continue
      const xmlUrl = edgarDocUrl(cik, accession, primaryDoc)
      const htmlUrl = String(f['url'] ?? xmlUrl)
      try {
        const xml = await getText(ctx, xmlUrl)
        const parsed = parseForm4Xml(xml, {
          ticker: symbol.toUpperCase(),
          filed: String(f['filingDate'] ?? ''),
          url: htmlUrl,
        })
        for (const t of parsed) {
          if (openMarketOnly && t.code !== 'P' && t.code !== 'S') continue
          rows.push(t)
        }
      } catch {
        // Skip malformed XML without failing the whole batch.
      }
    }
    return { company: data.name || name, cik, rows }
  },
})

export const form144 = defineSource({
  description:
    'Electronic Form 144 executive & affiliate restricted-stock intent-to-sell notices (filed on the day a sell order is placed with a broker): seller name, relationship, broker, proposed shares to sell, aggregate market value, and approximate sale date. No key needed.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    limit: z.number().int().min(1).max(20).default(10),
  }),
  async run({ ticker: symbol, limit }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    // Form 144 is often filed under the selling insider's CIK referencing the issuer CIK, so EFTS finds all of them.
    const params = new URLSearchParams({
      forms: '144',
      ciks: cik,
      dateRange: 'custom',
      startdt: '2023-04-01',
      from: '0',
      size: String(Math.min(limit * 2, 40)),
    })
    const payload = (await getJson(ctx, `https://efts.sec.gov/LATEST/search-index?${params.toString()}`)) as {
      hits?: { hits?: Record<string, unknown>[] }
    }
    const hits = (payload.hits?.hits ?? [])
      .sort((a, b) => {
        const da = String((a['_source'] as Record<string, unknown> | undefined)?.['file_date'] ?? '')
        const db = String((b['_source'] as Record<string, unknown> | undefined)?.['file_date'] ?? '')
        return db.localeCompare(da)
      })
      .slice(0, limit)

    const rows: ParsedForm144Notice[] = []
    for (const hit of hits) {
      const [adshRaw, doc = ''] = String(hit['_id'] ?? '').split(':')
      const src = (hit['_source'] ?? {}) as Record<string, unknown>
      const adsh = String(src['adsh'] ?? adshRaw ?? '')
      const rawDoc = stripXslPrefix(doc)
      if (!adsh || !rawDoc.endsWith('.xml')) continue
      // Form 144 archive directory lives under the issuer CIK or first CIK in ciks.
      const ciks = Array.isArray(src['ciks']) ? (src['ciks'] as string[]) : [cik]
      const archiveCik = ciks[0] ?? cik
      const xmlUrl = edgarDocUrl(archiveCik, adsh, rawDoc)
      const viewUrl = edgarDocUrl(archiveCik, adsh, doc || rawDoc)
      try {
        const xml = await getText(ctx, xmlUrl)
        rows.push(
          parseForm144Xml(xml, {
            ticker: symbol.toUpperCase(),
            filed: String(src['file_date'] ?? ''),
            url: viewUrl,
          }),
        )
      } catch {
        // Try fallback under the issuer's own CIK folder when ciks[0] was the reporting owner's CIK.
        try {
          const altXml = await getText(ctx, edgarDocUrl(cik, adsh, rawDoc))
          rows.push(
            parseForm144Xml(altXml, {
              ticker: symbol.toUpperCase(),
              filed: String(src['file_date'] ?? ''),
              url: edgarDocUrl(cik, adsh, doc || rawDoc),
            }),
          )
        } catch {
          // Skip unreachable notice.
        }
      }
    }
    return { company: name, cik, rows }
  },
})

export const activistFilings = defineSource({
  description:
    'Beneficial ownership >5% and activist investor filings (Schedule 13D, 13D/A, 13G, 13G/A) filed for a company, newest first, with reporting filer names and sec.gov links. No key needed.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    schedule13DOnly: z
      .boolean()
      .default(false)
      .describe('When true, return only active/activist Schedule 13D and 13D/A filings.'),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  async run({ ticker: symbol, schedule13DOnly, limit }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    const forms = schedule13DOnly ? 'SC 13D' : 'SC 13D,SC 13G'
    const params = new URLSearchParams({
      forms,
      ciks: cik,
      dateRange: 'custom',
      startdt: '2020-01-01',
      from: '0',
      size: String(limit),
    })
    const payload = (await getJson(ctx, `https://efts.sec.gov/LATEST/search-index?${params.toString()}`)) as {
      hits?: { hits?: Record<string, unknown>[] }
    }
    const rows = normalizeEftsHits(payload.hits?.hits ?? []).sort((a, b) => b.filed.localeCompare(a.filed))
    return { company: name, cik, rows }
  },
})

export const subsidiaries = defineSource({
  description:
    'Extracts a public company’s significant operating subsidiaries and jurisdictions of incorporation from Exhibit 21 (EX-21 / EX-21.1) of its latest Form 10-K—useful for linking court dockets, regulatory permits, or government contracts back to the parent ticker. No key needed.',
  hosts: HOSTS,
  input: z.object({
    ticker,
    limit: z.number().int().min(1).max(1000).default(250),
  }),
  async run({ ticker: symbol, limit }, ctx) {
    const { cik, name } = await lookup(ctx, symbol)
    const data = (await getJson(ctx, `https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions
    const tenK = rowsOf(data.filings.recent, cik).find((r) => String(r['form'] ?? '') === '10-K')
    if (!tenK) throw new Error(`No recent Form 10-K found on EDGAR for ${symbol.toUpperCase()}.`)
    const accession = String(tenK['accessionNumber'] ?? '')
    const filingDate = String(tenK['filingDate'] ?? '')
    const indexUrl = edgarDocUrl(cik, accession, 'index.json')
    const dir = (await getJson(ctx, indexUrl)) as { directory?: { item?: { name?: string }[] } }
    const items = dir.directory?.item ?? []
    const exFile =
      items.find((it) => /ex[-_.]?21/i.test(String(it.name ?? '')) && /\.htm(l)?$/i.test(String(it.name ?? ''))) ??
      items.find((it) => /21\.1|ex21/i.test(String(it.name ?? '')) && /\.(htm|html|txt)$/i.test(String(it.name ?? '')))
    if (!exFile?.name) {
      return { company: data.name || name, cik, filingDate, rows: [], note: 'Latest 10-K carried no separate Exhibit 21 file.' }
    }
    const exUrl = edgarDocUrl(cik, accession, exFile.name)
    const html = await getText(ctx, exUrl)
    const rows = parseExhibit21Html(html, {
      parentTicker: symbol.toUpperCase(),
      parentCik: cik,
      filingDate,
      url: exUrl,
    }).slice(0, limit)
    return { company: data.name || name, cik, filingDate, exhibitUrl: exUrl, rows }
  },
})
