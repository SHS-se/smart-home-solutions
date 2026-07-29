# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

**Via Lovable:** open [Lovable](https://lovable.dev/projects/REPLACE_WITH_PROJECT_ID) and click on Share -> Publish.

**Via Cloudflare Pages (Wrangler):** this repo is configured for Direct Upload deployments
([`wrangler.toml`](wrangler.toml)). The Vite SPA builds to `dist/`, with
[`public/_redirects`](public/_redirects) providing the React Router SPA fallback and
[`public/_headers`](public/_headers) setting asset caching.

```sh
# One-time: authenticate Wrangler with your Cloudflare account
npx wrangler login

# Build and deploy to Cloudflare Pages
npm run deploy

# Optional: build and preview the production output locally on the Pages runtime
npm run cf:dev
```

The first `npm run deploy` creates a Pages project named `prod-smart-home-solutions`
(rename in `wrangler.toml`). The build bakes in the `VITE_SUPABASE_*` values from your
local `.env`, and `vite.config.ts` refuses to build if the resolved env mixes test and
live values (Supabase project, `VITE_APP_ENV`, Stripe key). Local dev overrides live in
`.env.development.local` (written by `scripts/dev.sh`), which builds never load. The Supabase publishable/anon key is public by design, so nothing
secret ships in the bundle.

**Automated CI/CD:** [`.github/workflows/ci-deploy.yml`](.github/workflows/ci-deploy.yml)
runs lint + unit tests + build on every push and pull request. After the gate passes, a
push to `dev` deploys to the `test-smart-home-solutions` project
(https://test-smart-home-solutions.pages.dev) and a push to `main` deploys to
`prod-smart-home-solutions` (https://prod-smart-home-solutions.pages.dev); each deploy then
prunes that project's older deployments, keeping only the latest. Add two repository secrets
under *Settings → Secrets and variables → Actions* to enable the deploy step:

- `CLOUDFLARE_API_TOKEN` — a token with the *Cloudflare Pages: Edit* permission
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)
