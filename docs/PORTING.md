# Porting Lookbook into a React host application

This maps every module in this repo onto a typical embedded-Looker host architecture
(React 17 host + sandboxed iframe + `window.postMessage` bridge) and lists the
restricted-build-environment constraints that shaped the code.

## Target architecture

```
LOOKER HOST APP (React 17, no JSX)
  <host package>/src/Chat.tsx
  - engine switcher toggle (existing chat UI ⇄ ObservableHQ Reactive Canvas)
  - Looker SDK query runner (@looker/sdk: useSDK, run_inline_query)
        │  window.postMessage bridge (validated origin, request ids)
        ▼
SANDBOXED IFRAME (sandbox="allow-scripts")
  <host package>/observable-app/
  - this repo, nearly verbatim: index.html, styles.css, src/*
```

## Module mapping

| This repo | Lands in | Notes |
|---|---|---|
| `index.html`, `styles.css`, `src/views.js`, `src/main.js` | `observable-app/` | Already framework-free; ship as iframe static assets. |
| `src/runtime.js` | `observable-app/` | Replace CDN ESM imports with vendored copies (see below). |
| `src/notebook.js`, `src/profiler.js`, `src/compiler.js`, `src/agent.js` | `observable-app/` | Pure JS, no changes. |
| `src/looker.js` → `MockLookerClient` | delete | Demo-only. |
| `src/looker.js` → `PostMessageLookerClient` | `observable-app/` | The production client. Protocol below. |
| `src/data.js` | delete (or keep for offline eval) | |
| `bench.html`, `tests/` | `observable-app/eval/` | Browser + node test suites; run headless in CI. |

## The postMessage protocol

Iframe → host:

```json
{ "type": "LOOKBOOK_QUERY", "requestId": 7,
  "spec": { "model": "thelook", "view": "order_items",
            "fields": ["products.brand", "order_items.total_revenue"],
            "filters": { "order_items.created_year": "2025" },
            "sorts": ["-order_items.total_revenue"], "limit": 10 } }
```

Host → iframe:

```json
{ "type": "LOOKBOOK_RESULT", "requestId": 7,
  "payload": { "rows": [ { "products.brand": "…", "order_items.total_revenue": 123 } ],
               "sql": "…", "elapsedMs": 312 } }
```

Host-side handler (React 17, **no JSX** — `React.createElement` in `.ts` files so it
builds cleanly under strict TS build rules without JSX compiler flags):

```ts
// Chat.tsx — inside the Reactive Canvas engine branch
const sdk = useSDK();
React.useEffect(() => {
  const onMessage = async (ev: MessageEvent) => {
    if (ev.origin !== OBSERVABLE_APP_ORIGIN) return;      // validated bridge
    const msg = ev.data;
    if (msg?.type !== "LOOKBOOK_QUERY") return;
    try {
      const rows = await sdk.ok(sdk.run_inline_query({
        result_format: "json", body: msg.spec,            // spec passes through verbatim
      }));
      iframeRef.current?.contentWindow?.postMessage(
        { type: "LOOKBOOK_RESULT", requestId: msg.requestId, payload: { rows } },
        OBSERVABLE_APP_ORIGIN);
    } catch (e) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "LOOKBOOK_RESULT", requestId: msg.requestId, error: String(e) },
        OBSERVABLE_APP_ORIGIN);
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}, [sdk]);
```

Non-negotiables preserved by this design:

- **All** query execution goes through `@looker/sdk` (`run_inline_query`, `sdk.ok`).
  Row-level security, user permissions, and model access grants stay enforced. The
  iframe never holds credentials and never fetches.
- The iframe stays `sandbox="allow-scripts"`; the bridge validates `ev.origin` both ways
  and correlates by `requestId` (see `PostMessageLookerClient`).

## Restricted-build constraints already honored

1. **No JSX needed** — the iframe app is framework-free; the host snippet above uses
   `React.createElement`-compatible patterns only.
2. **No dynamic CDN `<script>` tags in production.** `src/runtime.js` is the only file
   with CDN imports. Vendor the four pinned libraries into your third-party bundle
   (or serve them as sandboxed-iframe static assets) and rewrite four import specifiers:
   `@observablehq/runtime@5.9.3`, `@observablehq/plot@0.6.16`, `d3@7.9.0`, `marked@12.0.2`.
3. **Pinned versions** match the host's existing dependency table; nothing new is
   required beyond the two ObservableHQ packages, which are the point.
4. **Fonts**: Google Sans / Roboto Mono via your standard font pipeline instead of
   fonts.googleapis.com.

## Wiring Gemini (one call per turn)

`src/gemini.js` ships a working Vertex AI `generateContent` adapter (already wired in
`main.js` behind a localStorage config; see that file's header for local setup). It is
deliberately NOT a managed data-agent chat endpoint — those return server-generated
Vega-Lite payloads, which is the architecture being replaced. In the shipped product,
route the same call through the React host (which holds auth), exactly like
LOOKBOOK_QUERY:

```js
import { planWithLLM } from "./compiler.js";

const result = await planWithLLM(ctx, async ({ system, user }) => {
  const res = await geminiGenerateContent({     // your existing Gemini client
    systemInstruction: system,
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });
  return res.text;
});
```

Contract details that keep weak models on rails:

- The context is capped by construction: field catalog + notebook outline + <150-token
  profiles per live query. No raw rows, ever (`profiler.js` is the gate).
- The output schema is small and closed: `{answer, patches[]}` with three patch ops.
- `planWithLLM` validates the shape and **falls back to the rules planner** on any
  parse failure — a bad model turn degrades to a good deterministic turn, never an error.
- Generated `js` cells compile against a tiny builtin surface (`Plot`, `d3`, `fmt`,
  `kpi`, `kpiRow`, `table`, `scheme`) — the same names the system prompt documents.

## Persistence

- `💾 Save` serializes `{cells, history}` to `.lookernb.json` (`serializeNotebook`).
- For "Save to Looker": map each `query` cell to a Look/tile via its inline-query spec
  (it is already the exact body `create_query` accepts) and store the notebook JSON as a
  User Defined Dashboard artifact. Round-trip is lossless because the spec is never
  transformed.

## Undo/redo semantics

Every mutation — chat turn, field-pill swap, filter-pill removal, manual source edit,
cell deletion — flows through `applyPatches`, which returns inverse patches.
`Cmd+Z` / `Cmd+Shift+Z` walk that stack. There is no second history mechanism to keep
consistent; the revision panel renders the same patch records as line diffs.
