import { useEffect, useState, type ReactElement } from 'react'
import { useBridge, useData, usePanelState, usePublish, type PanelRef } from '@jaspers-ai/sdk'
import { buildSecOutput, readSecState, type SecState, type SecTab } from './sec.ts'
import './styles.css'

const TABS: { id: SecTab; label: string }[] = [
  { id: 'filings', label: 'Filings' },
  { id: 'insider-trades', label: 'Form 4 Trades' },
  { id: 'form-144', label: 'Form 144 Sales' },
  { id: 'activists', label: '13D / 13G' },
  { id: 'search', label: 'Full-Text Search' },
]

function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const rows = (data as Record<string, unknown>)['rows']
    if (Array.isArray(rows)) return rows as Record<string, unknown>[]
  }
  return []
}

function fmtNum(val: unknown, digits = 0): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—'
  return digits > 0
    ? val.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : Math.round(val).toLocaleString('en-US')
}

export function SecView({ panel }: { panel: PanelRef }): ReactElement {
  const initial = useData(`workspaces/${panel.workspaceId}/panels/${panel.id}/state`)
  if (initial === undefined) return <div className="sc-root"><p className="sc-note">Loading…</p></div>
  return <SecPanel panel={panel} initial={initial} />
}

function SecPanel({ panel, initial }: { panel: PanelRef; initial: unknown }): ReactElement {
  const first = readSecState(initial)
  const [ticker, setTicker] = usePanelState<string>(panel, 'ticker', first.ticker)
  const [tab, setTab] = usePanelState<SecTab>(panel, 'tab', first.tab)
  const [form, setForm] = usePanelState<string>(panel, 'form', first.form)
  const [query, setQuery] = usePanelState<string>(panel, 'query', first.query)
  const [limit] = usePanelState<number>(panel, 'limit', first.limit)
  const state = readSecState({ ticker, tab, form, query, limit })

  const [tickerDraft, setTickerDraft] = useState(state.ticker)
  const [formDraft, setFormDraft] = useState(state.form)
  const [queryDraft, setQueryDraft] = useState(state.query)

  useEffect(() => setTickerDraft(state.ticker), [state.ticker])
  useEffect(() => setFormDraft(state.form), [state.form])
  useEffect(() => setQueryDraft(state.query), [state.query])

  const ready = state.tab === 'search' ? Boolean(state.query) : Boolean(state.ticker)

  return (
    <div className="sc-root">
      <div className="sc-bar">
        <input
          className="sc-input sc-ticker"
          value={tickerDraft}
          placeholder="AAPL"
          aria-label="Ticker symbol"
          onChange={(e) => setTickerDraft(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setTicker(tickerDraft.trim().toUpperCase())
          }}
          onBlur={() => {
            const next = tickerDraft.trim().toUpperCase()
            if (next !== state.ticker) setTicker(next)
          }}
        />
        {state.tab === 'filings' && (
          <input
            className="sc-input sc-form"
            value={formDraft}
            placeholder="Form"
            aria-label="Form filter"
            onChange={(e) => setFormDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setForm(formDraft.trim().toUpperCase())
            }}
            onBlur={() => {
              const next = formDraft.trim().toUpperCase()
              if (next !== state.form) setForm(next)
            }}
          />
        )}
        {state.tab === 'search' && (
          <input
            className="sc-input sc-query"
            value={queryDraft}
            placeholder={'"subpoena" or "Wells notice"'}
            aria-label="EDGAR full-text query"
            onChange={(e) => setQueryDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setQuery(queryDraft.trim())
            }}
            onBlur={() => {
              const next = queryDraft.trim()
              if (next !== state.query) setQuery(next)
            }}
          />
        )}
        <div className="sc-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`sc-tab ${state.tab === t.id ? 'sc-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sc-body">
        {!ready ? <Empty panel={panel} state={state} /> : <SecBody panel={panel} state={state} />}
      </div>
    </div>
  )
}

function Empty({ panel, state }: { panel: PanelRef; state: SecState }): ReactElement {
  usePublish(panel, buildSecOutput(state, []))
  return (
    <p className="sc-note">
      {state.tab === 'search'
        ? 'Enter a phrase (e.g. "subpoena", "Wells notice", "going concern") to search across SEC EDGAR filings.'
        : 'Enter a ticker symbol (e.g. AAPL, NVDA) to inspect SEC filings, parsed Form 4 insider trades, Form 144 sell notices, and 13D/13G stakes.'}
    </p>
  )
}

function OpenButton({ label, url }: { label: string; url: unknown }): ReactElement {
  const bridge = useBridge()
  const href = typeof url === 'string' && url.startsWith('https://') ? url : ''
  if (!href) return <span>{label}</span>
  return (
    <button type="button" className="sc-link" onClick={() => void bridge.openLink(href)}>
      {label}
    </button>
  )
}

function SecBody({ panel, state }: { panel: PanelRef; state: SecState }): ReactElement {
  const source =
    state.tab === 'insider-trades'
      ? 'sec/insider-trades'
      : state.tab === 'form-144'
        ? 'sec/form-144'
        : state.tab === 'activists'
          ? 'sec/activist-filings'
          : state.tab === 'search'
            ? 'sec/search'
            : 'sec/filings'

  const args =
    state.tab === 'insider-trades'
      ? { ticker: state.ticker, filingsToParse: Math.min(state.limit, 15) }
      : state.tab === 'form-144'
        ? { ticker: state.ticker, limit: Math.min(state.limit, 15) }
        : state.tab === 'activists'
          ? { ticker: state.ticker, limit: state.limit }
          : state.tab === 'search'
            ? {
                query: state.query,
                ...(state.ticker ? { ticker: state.ticker } : {}),
                ...(state.form ? { forms: state.form } : {}),
                limit: state.limit,
              }
            : { ticker: state.ticker, ...(state.form ? { form: state.form } : {}), limit: state.limit }

  const run = useData(source, args)
  const rows = rowsOf(run.data)
  usePublish(panel, buildSecOutput(state, rows))

  if (run.error) return <p className="sc-error">{run.error}</p>
  if (run.loading && rows.length === 0) return <p className="sc-note">Loading SEC EDGAR data…</p>
  if (rows.length === 0) return <p className="sc-note">No matching SEC filings found.</p>

  if (state.tab === 'insider-trades') {
    return (
      <table className="sc-table">
        <thead>
          <tr>
            <th>Tx Date</th>
            <th>Insider</th>
            <th>Role</th>
            <th>Code</th>
            <th className="sc-num">Shares</th>
            <th className="sc-num">Price</th>
            <th className="sc-num">Value ($)</th>
            <th>10b5-1</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const code = String(row['code'] ?? '')
            const tone = code === 'P' ? 'sc-buy' : code === 'S' ? 'sc-sell' : ''
            return (
              <tr key={`${String(row['transactionDate'] ?? '')}-${idx}`}>
                <td>{String(row['transactionDate'] ?? '')}</td>
                <td>
                  <OpenButton label={String(row['insiderName'] ?? '')} url={row['url']} />
                </td>
                <td>{String(row['insiderTitle'] ?? '').slice(0, 32)}</td>
                <td className={tone}>{code}</td>
                <td className="sc-num">{fmtNum(row['shares'])}</td>
                <td className="sc-num">{fmtNum(row['pricePerShare'], 2)}</td>
                <td className="sc-num">{fmtNum(row['totalValue'])}</td>
                <td>{row['rule10b51'] ? 'Yes' : 'No'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )
  }

  if (state.tab === 'form-144') {
    return (
      <table className="sc-table">
        <thead>
          <tr>
            <th>Filed</th>
            <th>Sale Date</th>
            <th>Seller</th>
            <th>Role</th>
            <th className="sc-num">Shares</th>
            <th className="sc-num">Est. Value ($)</th>
            <th>Broker</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${String(row['filed'] ?? '')}-${idx}`}>
              <td>{String(row['filed'] ?? '')}</td>
              <td>{String(row['approxSaleDate'] ?? '')}</td>
              <td>
                <OpenButton label={String(row['sellerName'] ?? '')} url={row['url']} />
              </td>
              <td>{String(row['relationship'] ?? '')}</td>
              <td className="sc-num">{fmtNum(row['sharesToSell'])}</td>
              <td className="sc-num">{fmtNum(row['aggregateMarketValue'])}</td>
              <td>{String(row['broker'] ?? '').slice(0, 28)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  if (state.tab === 'search' || state.tab === 'activists') {
    return (
      <table className="sc-table">
        <thead>
          <tr>
            <th>Filed</th>
            <th>Form</th>
            <th>Filer / Company</th>
            <th>Items</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${String(row['accessionNumber'] ?? idx)}`}>
              <td>{String(row['filed'] ?? '')}</td>
              <td>
                <OpenButton label={String(row['form'] ?? '')} url={row['url']} />
              </td>
              <td>{String(row['company'] ?? '').slice(0, 64)}</td>
              <td>{String(row['items'] ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <table className="sc-table">
      <thead>
        <tr>
          <th>Filed</th>
          <th>Report Date</th>
          <th>Form</th>
          <th>Description</th>
          <th>Items</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr key={`${String(row['accessionNumber'] ?? idx)}`}>
            <td>{String(row['filingDate'] ?? '')}</td>
            <td>{String(row['reportDate'] ?? '')}</td>
            <td>
              <OpenButton label={String(row['form'] ?? '')} url={row['url']} />
            </td>
            <td>{String(row['primaryDocDescription'] ?? row['primaryDocument'] ?? '').slice(0, 48)}</td>
            <td>{String(row['items'] ?? '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
