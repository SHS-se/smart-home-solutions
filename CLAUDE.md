# Project instructions

## Branch workflow: dev first, then main

**All changes go to the `dev` branch first** so they can be tested before reaching production. Never commit feature work directly to `main`.

- `dev` → **test**: builds against the TEST Supabase (`vxqpgbzseckgceopitpm`) and deploys to the `test-smart-home-solutions` Pages project at https://test-smart-home-solutions.pages.dev. CI also applies Supabase **migrations** to the test project.
- `main` → **production**: builds against the prod Supabase (`oosxndduqzhvrorgogaw`) and deploys to the `prod-smart-home-solutions` Pages project at https://prod-smart-home-solutions.pages.dev, applying migrations to prod.

Each environment is its own Cloudflare Pages project (a project's `*.pages.dev` subdomain *is* its name), and the deploying branch is that project's production branch — so the canonical URL above always points at the latest build, with no hash. After each deploy, CI prunes the project's older deployments, keeping only the latest live one.

CI (`.github/workflows/ci-deploy.yml`) runs on push to `main` or `dev` on the `prod` remote (`SHS-se/smart-home-solutions`). The `origin` remote (`philbert/...`) is a personal fork and is not the deploy target.

Promote tested work with a normal `dev` → `main` merge once it has been verified on the test deploy.

Note: **edge functions are NOT deployed by CI** — they are deployed manually (see `scripts/dev.sh` / Supabase CLI). A migration or page that depends on a new/changed edge function needs that function deployed separately.
