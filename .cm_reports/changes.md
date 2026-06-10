# Summary of Applied Changes

**Timestamp**: 6/10/2026, 2:00:44 PM
**Action**: Edit File
**File**: `src/webview/src/App.tsx`
**Lines**: 1181 to 1227

## Changes Applied

### Removed (Search Block):
```tsx
{/* Pricing / Token stats bar */}
        {usage && (() => {
          const activeModel = modelsList.find((m) => m.id === model);
          const contextLimit = activeModel?.context_length || 0;
          const usedTokens = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0);
          const contextPct = contextLimit > 0 ? Math.min(100, (usedTokens / contextLimit) * 100) : 0;
          const ctxColor =
            contextPct >= 90 ? 'text-red-400' :
            contextPct >= 70 ? 'text-amber-400' :
            'text-emerald-400';
          return (
            <div className="flex items-center justify-between px-2 py-1 bg-vscode-inputBg/15 border border-vscode-inputBorder/15 rounded text-vscode-fg/40 font-mono select-none animate-fade-in">
              <div className="flex items-center space-x-2.5">
                <div className="flex items-center space-x-1" title={`Prompt tokens: ${usage.input}`}>
                  <ArrowDown className="h-3 w-3 text-cyan-400" />
                  <span className="text-[9px]">{usage.input}</span>
                </div>
                <div className="flex items-center space-x-1" title={`Completion tokens: ${usage.output}`}>
                  <ArrowUp className="h-3 w-3 text-purple-400" />
                  <span className="text-[9px]">{usage.output}</span>
                </div>
                {contextLimit > 0 && (
                  <div className={`flex items-center space-x-1 ${ctxColor} font-semibold`} title={`Context window usage: ${contextPct.toFixed(1)}%`}>
                    <Gauge className="h-3 w-3" />
                    <span className="text-[9px]">{contextPct.toFixed(0)}%</span>
                    <div className="relative w-12 h-1 bg-vscode-bg/60 rounded-full overflow-hidden border border-vscode-inputBorder/30">
                      <div
                        className={`h-full transition-all duration-300 ${
                          contextPct >= 90 ? 'bg-red-500' :
                          contextPct >= 70 ? 'bg-amber-500' :
                          'bg-emerald-500'
                        }`}
                        style={{ width: `${contextPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              {usage.cacheRead > 0 && (
                <div className="flex items-center space-x-1 text-emerald-400 font-semibold" title={`Cached tokens: ${usage.cacheRead}`}>
                  <Database className="h-3 w-3" />
                  <span className="text-[9px]">{usage.cacheRead}</span>
                </div>
              )}
            </div>
          );
        })()}
```

### Added (Replace Block):
```tsx
{/* Pricing / Token stats bar */}
        {usage && (() => {
          const activeModel = modelsList.find((m) => m.id === model);
          const contextLimit = activeModel?.context_length || 0;
          const usedTokens = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0);
          const contextPct = contextLimit > 0 ? Math.min(100, (usedTokens / contextLimit) * 100) : 0;
          const ctxColor =
            contextPct >= 90 ? 'text-red-400' :
            contextPct >= 70 ? 'text-amber-400' :
            'text-emerald-400';

          const promptPrice = parseFloat(activeModel?.pricing?.prompt || '0');
          const completionPrice = parseFloat(activeModel?.pricing?.completion || '0');
          const cachedInputPrice = getCachedInputPrice(activeModel);
          const inputCost = (usage.input || 0) * promptPrice;
          const outputCost = (usage.output || 0) * completionPrice;
          const cacheCost = (usage.cacheRead || 0) * cachedInputPrice;
          const totalCost = inputCost + outputCost + cacheCost;

          return (
            <div className="flex flex-col gap-1 px-2 py-1 bg-vscode-inputBg/15 border border-vscode-inputBorder/15 rounded text-vscode-fg/40 font-mono select-none animate-fade-in">
              <div className="flex items-center justify-between gap-3">
                <div className={`flex items-center space-x-1 ${ctxColor} font-semibold`} title={`Context window usage: ${contextPct.toFixed(1)}%`}>
                  <Gauge className="h-3 w-3" />
                  <span className="text-[9px]">{contextPct.toFixed(0)}%</span>
                </div>

                {usage.cacheRead > 0 && (
                  <div className="flex items-center space-x-1 text-emerald-400 font-semibold" title={`Cached tokens: ${usage.cacheRead}`}>
                    <Database className="h-3 w-3" />
                    <span className="text-[9px]">{usage.cacheRead}</span>
                    <span className="text-[9px] text-vscode-fg/35">cache</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 text-[9px]">
                <span className="text-vscode-fg/35">Total cost</span>
                <span className="text-emerald-300 font-semibold" title={`Prompt: $${inputCost.toFixed(6)} · Completion: $${outputCost.toFixed(6)} · Cache: $${cacheCost.toFixed(6)}`}>
                  ${totalCost.toFixed(6)}
                </span>
              </div>
            </div>
          );
        })()}
```
