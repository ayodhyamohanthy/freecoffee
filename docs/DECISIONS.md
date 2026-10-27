
## 2026-10-27 — Baseline security headers on Worker API responses (Fo)
The Worker's `corsHeaders()` set CORS, JSON content type and no-store, but no
hardening headers. Every API response (the API takes payments and serves the
admin surface) now also carries `x-content-type-options: nosniff`,
`referrer-policy: strict-origin-when-cross-origin` and `x-frame-options: DENY`.
nosniff stops a response body being reinterpreted as script or stylesheet; the
strict referrer policy keeps ad-click and bid URLs out of third-party
referrer headers; frame DENY keeps the API out of clickjacking iframes.
test.sh's JS-syntax step now guards the three headers inside corsHeaders, so a
refactor that drops them fails the suite. Branch fo/freecoffee-worker-sec-headers.
