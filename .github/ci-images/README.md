# CI dependency images

The CI workflow uses two repository-linked GitHub Container Registry images.
The checks image contains Node, Deno and the packages from the npm lockfile.
The browser image adds Playwright's browsers and system libraries. Its browser
version comes from the same lockfile.

Pull requests build their candidate images without registry write access. Pushes
to `dev` or `main` publish missing images keyed by the dependency manifests and
Docker recipe. CI pulls the resulting digests. The build context contains only
the npm manifests and the Docker recipe.

Dependabot proposes weekly npm, Docker base image and GitHub Actions updates
against `dev` once its configuration reaches the default branch. Merge those
updates through the normal CI checks. Changes to the lockfile or Docker recipe
trigger publication of new images. The Rust, Home Assistant and deploy jobs
continue to use their own toolchains.
