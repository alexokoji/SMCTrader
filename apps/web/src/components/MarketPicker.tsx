import { useMemo, useState } from "react";

/**
 * Market selection for an agent.
 *
 * The list comes from the exchanges the engine actually reads, so a market
 * offered here is one the analysis can obtain candles for. It is long, so the
 * control is a searchable list rather than a plain multi-select, and selected
 * markets stay visible as removable chips while searching.
 */
export function MarketPicker({
  available,
  selected,
  error,
  onChange,
  maxVisible = 60,
}: {
  available: string[];
  selected: string[];
  error?: string | null;
  onChange: (symbols: string[]) => void;
  maxVisible?: number;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const term = query.trim().toUpperCase();
    const pool = term ? available.filter((symbol) => symbol.includes(term)) : available;
    // Selected markets are shown as chips above, so they are not repeated here.
    return pool.filter((symbol) => !selected.includes(symbol));
  }, [available, selected, query]);

  const toggle = (symbol: string) => {
    onChange(selected.includes(symbol) ? selected.filter((s) => s !== symbol) : [...selected, symbol]);
  };

  return (
    <div className="market-picker">
      <h4 className="field-label">
        Markets{selected.length > 0 && <em>{selected.length} selected</em>}
      </h4>

      {selected.length > 0 && (
        <div className="chip-row">
          {selected.map((symbol) => (
            <button key={symbol} className="chip" onClick={() => toggle(symbol)} aria-label={`Remove ${symbol}`}>
              {symbol} <i aria-hidden="true">×</i>
            </button>
          ))}
        </div>
      )}

      {available.length === 0 ? (
        <p className="helper">
          {error
            ? `Market list unavailable: ${error} You can still create the agent once the list loads.`
            : "Loading tradeable markets…"}
        </p>
      ) : (
        <>
          <div className="inline-form">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${available.length} markets, e.g. BTC`}
              aria-label="Search markets"
            />
          </div>
          <div className="market-options">
            {matches.slice(0, maxVisible).map((symbol) => (
              <button key={symbol} className="market-option" onClick={() => toggle(symbol)}>
                {symbol}
              </button>
            ))}
            {matches.length === 0 && (
              <p className="helper">
                {query ? `No market matches "${query}".` : "Every available market is selected."}
              </p>
            )}
          </div>
          {matches.length > maxVisible && (
            <p className="helper">
              Showing {maxVisible} of {matches.length} matches. Narrow the search to see more.
            </p>
          )}
        </>
      )}
    </div>
  );
}
