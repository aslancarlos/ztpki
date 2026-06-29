# ztpki

Web tool to **search and revoke certificates in Venafi Zero Touch PKI**
(ZTPKI / HydrantID ACM). The browser UI never touches the ZTPKI API directly:
a small Node proxy signs each request with your **HAWK** credentials
server-side, so the HAWK secret is only used to sign and is **never logged or
stored**.

This is the standalone extraction of the `/ztpki` tool that runs at
`machine.minha.cloud/ztpki` (originally a page inside the
*machine-identity-explainer* app).

## Layout

```
api/            ZTPKI HAWK-signing proxy (Node, no dependencies)
  server.cjs      HTTP server, exposes POST /ztpki (+ /health)
  ztpki.cjs       HAWK signing + SSRF guard + ZTPKI REST call
web/            React + Vite + TypeScript UI
  src/ZtpkiPage.tsx   the certificate manager page
```

## How it works

- The UI (`ZtpkiPage`) collects the ZTPKI **base URL**, **HAWK id/secret** and
  the search/revoke action, then `POST`s to `/api/ztpki`.
- `api/server.cjs` validates the input (method + path allow-list, SSRF guard)
  and calls `ztpki.call()`, which builds the per-request HMAC-SHA256 HAWK
  `Authorization` header and forwards to ZTPKI.
- ZTPKI endpoints used: `POST /certificates/` (list/search),
  `GET /certificates/{id}/status`, `PATCH /certificates/{id}` (revoke).

## Run locally

```bash
# 1) backend proxy (port 3001)
cd api && npm start

# 2) frontend (Vite dev server, proxies /api -> :3001)
cd web && npm install && npm run dev
# open the printed http://localhost:5173
```

Build the static UI with `cd web && npm run build` (output in `web/dist/`).
Serve `web/dist/` behind any web server and run `api/server.cjs` behind a
`/api/` route (see the original nginx: `location /api/ { proxy_pass http://127.0.0.1:3001/; }`).

## Security notes

- HAWK credentials are **transport-only**: used to sign one request, then
  discarded — never persisted or logged.
- The proxy enforces an **SSRF guard** (rejects private/internal hosts) and a
  **path allow-list** (`/certificates`, `/accounts`, `/organizations`).

## Demo CA certificate

`ZTPKIDemoRSAICA1.pem` is a ZTPKI demo issuing CA (intermediate) certificate
kept here for reference / trust-chain testing against the demo ZTPKI tenant.

## License

[Apache 2.0](./LICENSE).
