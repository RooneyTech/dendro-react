# Dendro React — Landing Page

Static HTML landing page for `dendroreact.com`. Matches the Rooney Tech web pattern (see `run-fun/web/`).

## Stack

- Single `index.html` with inline CSS (no build step)
- Dark theme using Dendro's neural palette (`#0A0E17` bg, `#00d4ff` cyan accent, `#009E73` green accent)
- Cloudflare Pages via `_headers` for security + caching

## Local preview

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

Or just double-click `index.html`.

## Deploy

### Cloudflare Pages (recommended, matches run-fun)

1. Register `dendroreact.com` at your preferred registrar (Cloudflare or GoDaddy)
2. Log into Cloudflare → Pages → Create project → Connect Git
3. Select the `dendro-react` repo, set build directory to `web/`
4. No build command, no build output dir (it's static)
5. Add `dendroreact.com` as a custom domain
6. Update nameservers to Cloudflare's if the domain is elsewhere

### Manual wrangler (if you prefer CLI)

```bash
cd web
npx wrangler pages deploy . --project-name dendro-react
```

## TODO before launch

- [ ] Record 75s demo video, embed in `#demo` section (replace placeholder)
- [ ] Add Open Graph preview image (1200x630 PNG) — currently falls back to favicon
- [ ] Test on mobile (responsive already, but verify)
- [ ] Add Plausible / Fathom analytics tag if desired (privacy-friendly)
- [ ] Swap CTA links to a real checkout when Lemon Squeezy is live
