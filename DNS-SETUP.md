# Custom domain status

The store currently runs on GitHub Pages at **https://thegadz.github.io/**.

The previous custom domain, `thegadz.store`, is **not active**. Its DNS was removed so GitHub Pages could serve the site correctly. Do not re-add a `CNAME` file or point DNS at GitHub Pages until the domain is renewed and its nameservers are under control.

## If the domain is renewed

1. Confirm the domain status and nameservers at the registrar.
2. Point the apex at GitHub Pages:

   ```text
   A      @    185.199.108.153
   A      @    185.199.109.153
   A      @    185.199.110.153
   A      @    185.199.111.153
   CNAME  www  thegadz.github.io
   ```

3. Add a `CNAME` file containing `thegadz.store` to the repository root and push to `master`.
4. In the GitHub repository settings → Pages, set the custom domain and enable **Enforce HTTPS** after the certificate is issued.
5. Verify both `https://thegadz.store/` and `https://www.thegadz.store/` load the storefront and can reach the API at `https://gadzstore-api.blueicespeed.workers.dev`.

## Current URLs

| Service | URL |
| --- | --- |
| Storefront | https://thegadz.github.io/ |
| API health | https://gadzstore-api.blueicespeed.workers.dev/api/health |
| Admin | https://gadzstore-api.blueicespeed.workers.dev/admin |

## API origin

The Worker uses permissive CORS for public catalog and order endpoints, so the storefront works from both `thegadz.github.io` and a future custom domain. No frontend change is required when the domain changes; the API base is set in the `api-base` meta tag in `index.html`.
