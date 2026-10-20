# M’LANG storefront

The storefront preview runs at [http://127.0.0.1:4173/](http://127.0.0.1:4173/). For Hostinger PHP/HTML hosting, the site now includes `api.php` and `.htaccess`; these keep the browser API paths working without Node.js.

To start it again later, open Terminal in this folder and run:

```sh
npm start
```

Product browsing, filters, search, saved pieces, cart, demo discount, and checkout are interactive. COD checkout validates and saves an order server-side; if Shiprocket is configured, it creates the COD shipment, assigns an AWB, and requests pickup. Without Shiprocket setup, the order is still saved with shipment status pending setup for admin follow-up. Razorpay checkout is separate; demo orders are explicitly labeled as no-payment local previews. Prices, shipping thresholds, and promo codes are sample values.

`shared/catalog.json` is the shared product source for the storefront and both server implementations. Add or update a tee there: keep its cart `id` stable, give it a unique `sku`, then set its name, price, color, photos, description, and fit. The available sizes and chart measurements are stored beside the products.

## Code map

- `index.html` — page structure and storefront sections.
- `frontend/styles.css` — visual styles and responsive layouts.
- `frontend/app.js` — product browsing, size selection, cart, checkout UI, and order history.
- `shared/catalog.json` — named product records, unique SKUs, size choices, and chart data.
- `api.php` — PHP API for Hostinger, including server-validated carts, account verification/login, COD orders, and Razorpay order/signature/capture verification.
- `backend/server.mjs` — local Node preview backend with Razorpay and Shiprocket integrations.
- `.htaccess` — routes `/api/...` calls to PHP and blocks public access to `.env` and private data.
- `public/assets/` — storefront and product images.
- `supabase/schema.sql` — private customer and order tables with RLS enabled.
- `.env` — local server secrets; keep it private and never upload it into a public web root.

## Hostinger PHP/HTML deployment

Upload the storefront files and `api.php` to the website's PHP document root. Keep `.htaccess` enabled (Apache `mod_rewrite` is required) so the existing `/api/...` requests reach the PHP API. `shared/catalog.json` and `public/assets/` must be uploaded at those exact paths. Enable PHP 8.1+, cURL and sessions in the Hostinger PHP settings. Set the backend secrets as hosting environment variables where available; otherwise place `.env` in the document root only after confirming the included `.htaccess` deny rule is active. Never commit or expose `.env`.

The PHP API persists orders and accounts in Supabase when the Supabase settings are present; otherwise it uses the private `data/` directory, which must be writable by PHP and blocked from public web access. Configure `PUBLIC_STORE_URL` to the final HTTPS domain and set `NODE_ENV=production` before enabling live Razorpay. Confirm the hosting PHP version, cURL, session storage, HTTPS, and API routes before taking real payments. The PHP API also supports Shiprocket booking/tracking and Resend receipts when their server-side credentials are configured.

The PHP registration flow stores new passwords using PHP's `password_hash`. Existing accounts created by the Node preview use scrypt hashes and cannot be signed into by this PHP backend; those users need a password-reset/migration path before switching production traffic. `ADMIN_PASSWORD_HASH` must be a PHP `password_hash()` value for a PHP admin login; the old Node scrypt bootstrap hash is not compatible.

## Razorpay test mode

1. Create or open a Razorpay account and switch its dashboard to **Test Mode**.
2. Generate a test key pair in the Razorpay dashboard.
3. Copy `.env.example` to `.env` and put the test key id and test key secret there. Do not paste the key secret into browser code or chat.
4. Restart with `npm start` and reload the page. The checkout button will launch Razorpay's hosted test checkout.

The server recomputes the cart total, creates the Razorpay order, verifies the payment signature, and checks that Razorpay reports a captured payment. It saves verified local test orders in `data/orders.json`; this folder is excluded from static serving and Git. The customer address is retained there on this computer so a local order can be reviewed. Use only test payments in this local build.

## Shiprocket order booking

After a Razorpay payment is verified, the server creates a custom order in Shiprocket, requests an AWB assignment, schedules pickup, and saves the AWB/status with the paid order. Configure a dedicated Shiprocket API user's email and password, the exact pickup-location name saved in your Shiprocket account, and the packed parcel's dimensions and weight in `.env`. API credentials must remain server-side. If setup is incomplete or Shiprocket rejects a booking, the paid order is still saved and its shipment remains pending/failed for manual handling; no-payment demo orders never create shipments.

The customer account tracking control reads tracking updates from Shiprocket by AWB. Shiprocket API users are created from **Settings → API → Add New API User**; use an API user email different from your main login. The API login returns a bearer token that the server refreshes automatically. Before live orders, verify the pickup location and packed parcel measurements in `.env`.

## Customer accounts and emails

The **ACCOUNT** control lets a customer register with email verification, sign in, review paid orders, and load Shiprocket tracking updates. Paid Razorpay checkout is linked to the signed-in email; the server verifies the session, payment signature, captured payment, and order amount before saving the order. Sessions use an HTTP-only cookie and are cleared when the local server restarts.

For email verification and order receipts, add a Resend API key and a sender address on a domain verified in Resend to `.env` (`RESEND_API_KEY`, `EMAIL_FROM`). Set `PUBLIC_STORE_URL` to the deployed HTTPS store URL so receipt account links work after hosting. Without those mail settings, sign-in and demo checkout still work, but new account registration and order emails stay unavailable. Carrier tracking requires an AWB and working Shiprocket API credentials.

## Supabase database and store admin

Create a Supabase project, run `supabase/schema.sql` once in its SQL Editor, then set `SUPABASE_URL` and a server-only `SUPABASE_SECRET_KEY` in `.env`. The backend stores verified accounts and paid orders in Supabase when configured; without those settings, the local preview continues using private JSON files. Keep the secret key out of browser files and Git. Supabase secret keys bypass RLS, so this app uses the key only from `backend/server.mjs`, after server-side account/admin checks.

`ADMIN_EMAIL=themalangverse@gmail.com` designates the owner account. For the Node preview, a one-time bootstrap password can be stored as an scrypt hash in `ADMIN_PASSWORD_HASH`; for PHP hosting, use a `password_hash()` value instead. Both enable admin sign-in without email verification. Customer registration and verification still require a Resend sender on a verified domain. Signing in as the owner opens the order panel with customer, address, items, payment, receipt-email, and Shiprocket details. Other signed-in customers can retrieve only orders matching their account email. Admin access is determined server-side from `ADMIN_EMAIL`, not from a browser toggle.

The full Return, Refund & Exchange Policy supplied by the store owner appears on the storefront Contact Us section. Checkout requires acknowledgement of that policy before a paid order can be created.

This preview is not ready for public/live sales. The server accepts the configured `PUBLIC_STORE_URL` host and origin; set `HOST=0.0.0.0` only on a real host behind HTTPS. Razorpay live mode is enabled only when `NODE_ENV=production`, `PUBLIC_STORE_URL` uses HTTPS, and matching live Key ID + Key Secret are configured. Local development should use Razorpay test keys. Never put private payment keys in browser code.

Before launch, configure and verify a deployed HTTPS host, production secrets, Resend sender domain, Shiprocket API user/pickup location/packed parcel dimensions, final prices and inventory, shipping/tax settings, privacy and legal pages, and backups. This build does not yet have carrier/payment webhooks or durable session storage; live inventory is not reserved across concurrent orders. Demo orders are browser-local previews only and do not enter the admin/Supabase order list. Newsletter signups are preview-only. Do not treat a demo order as a purchase.
