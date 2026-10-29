# Deploying

The build produces `dist/`, a folder of static files. Nothing runs on a server, so there is nothing to configure beyond "serve this folder".

```bash
npm ci
npm run build        # about two seconds; writes dist/
```

## Vercel (used for the live demo)

Import the repository. `vercel.json` already sets the install command, build command, output directory, headers and caching. The free Hobby plan is for non-commercial use under Vercel's terms; use another host (or a paid plan) for commercial deployments.

## Cloudflare Pages

1. Push the repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → connect the repository.
3. Build command `npm run build`, output directory `dist`. Framework preset: none.
4. Deploy. Every push to the default branch redeploys; pull requests get preview URLs.

Free-plan limits (per Cloudflare's documentation): 500 builds a month, 20,000 files per site, 25 MiB per file. The site is about 150 files and the largest is 1.5 MB.

`public/_headers` is copied into `dist/` and Cloudflare applies it: the Content-Security-Policy, security headers and long caching for hashed files.

## Any other host

Upload the contents of `dist/`. Notes:

- All links are relative, so the site works from a sub-path (`https://example.com/editor/`).
- Serve `sw.js` with `Cache-Control: no-cache` so updates reach people promptly. Files under `assets/`, `fonts/` and `vendor/` have content hashes or fixed versions and can be cached for a year.
- Copy the headers from `public/_headers` into your server's configuration to keep the Content-Security-Policy.
- Use HTTPS. Browsers only allow the service worker (offline use) and clipboard access on secure origins, and `localhost`.

## Custom domain and link previews

Set `SITE_URL` when building so the social-card tags use absolute addresses (on Vercel this is picked up automatically from the project's production domain):

```bash
SITE_URL=https://editor.example.com npm run build
```

On Cloudflare and Vercel, add it as a build environment variable. The link-preview image is `public/og-image.png`; `npm run screenshots` and `node scripts/promo.mjs` regenerate it.

## After a release

Each build gets a new service-worker cache name, so returning visitors pick up the new version the next time they open the page online, and the old cache is deleted.
