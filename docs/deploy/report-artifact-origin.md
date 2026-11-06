# Report origin (`REPORT_ARTIFACT_ORIGIN`) — deploy checklist

Code reports (AI Vibe Report / *Dán mã*) run the author's own HTML, CSS and JavaScript.
Custom JavaScript is only safe when the report document is served from a **dedicated
origin** that holds no AppBI session. That separate origin is what lets the runtime lock
navigation, both in Studio and on public/embed links. **Do not drop it.**

| `REPORT_ARTIFACT_ORIGIN` | Result |
|---|---|
| a dedicated subdomain, e.g. `https://report-docs.example.com` | data + charts + filters + CSS **and custom JS** |
| empty, or the app's own domain | data + charts + filters + CSS; **custom JS does not run** (not an error) |
| a loopback address (`127.0.0.1`, `localhost`) while the app has a public domain | **publishing is blocked**: every viewer would load the report from their own machine |

The startup log says which case applies (`origin_warning`). The Context Pack and the
AI report generator read the same setting, so they ask for a CSS-only page when JS is off.

## Checklist

1. DNS: `report-docs.<your-domain>` points at the same edge as the app.
2. TLS certificate covers that name.
3. `.env`: `REPORT_ARTIFACT_ORIGIN=https://report-docs.<your-domain>` (no trailing `/`).
   It must **not** be one of `CORS_ORIGINS`, otherwise it counts as the app's own origin.
4. The edge routes **only the two document paths** below on that host to the backend.
   Everything else on it answers 404. No `/api/v1/*` beyond those, no frontend.
5. Never set a cookie with `Domain=.<your-domain>`: the report host must not receive the
   AppBI session.
6. Restart the backend and check the log has no `REPORT_ARTIFACT_ORIGIN` warning.
7. Open a report that has JS in Studio: the pill reads "JS tùy biến bật · đã khóa điều hướng".
8. Open its public link: the JS behaviour works there too.

## The two document paths

| Path | Used by |
|---|---|
| `/api/v1/public/report-docs/{ticket}` (GET) and `/api/v1/public/report-docs/{ticket}/preview` (POST) | Studio preview (signed ticket, 10 minutes) |
| `/api/v1/public/reports/{token}/document` (GET) | public link and embed |

Both return code only (never data). Data reaches the frame over the host page's
MessagePort. The backend sets the CSP and `frame-ancestors` itself.

## nginx sample

```nginx
server {
    listen 443 ssl http2;
    server_name report-docs.example.com;
    # ssl_certificate / ssl_certificate_key ...

    # Studio documents (ticket) and their live preview
    location ~ ^/api/v1/public/report-docs/[^/]+(/preview)?$ {
        proxy_pass http://appbi-backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie "";          # the report host never carries a session
        client_max_body_size 4m;             # preview posts the editor source
    }

    # Public link / embed document
    location ~ ^/api/v1/public/reports/[^/]+/document$ {
        limit_except GET { deny all; }
        proxy_pass http://appbi-backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie "";
    }

    location / { return 404; }
}
```

Replace `appbi-backend:8000` with your backend upstream (on Docker Compose:
`http://backend:8000`).
