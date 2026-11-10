#!/usr/bin/env bash
set -e

test -f .env.e2e || cp .env.e2e.example .env.e2e

# Parallel-safe: project name comes from E2E_PROJECT (default coach-e2e), so
# concurrent CI runs on one Docker daemon never touch each other's stacks.
E2E_PROJECT="${E2E_PROJECT:-coach-e2e}"
export E2E_PROJECT

# Content hash of everything that goes into the app-e2e image: every tracked
# file the build context sees, minus paths .dockerignore drops or that never
# reach the image (docs, e2e specs, workflows, unit tests). Blob ids from the
# index, so it is stable across checkouts/merge refs of the same content and
# changes whenever any input does — the old `git log -1 -- <dirs>` key missed
# nuxt.config.ts, shared/, public/, i18n/ … and changed on every PR merge ref.
APP_HASH=$( {
  git ls-files -s -- . ':!:docs' ':!:e2e' ':!:.github' ':!:*.md' ':!:tests'
  git ls-files -s -- tests/fixtures/llm-mocks
} 2>/dev/null | sha256sum | cut -c1-12)
APP_HASH=${APP_HASH:-latest}
IMAGE_TAG="coach-e2e-app:${APP_HASH}"

build_image() {
  if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "=> Reusing existing Docker image $IMAGE_TAG (app source unchanged)"
    docker tag "$IMAGE_TAG" coach-e2e-app:local
    return
  fi
  echo "=> Building Docker image for app source hash $APP_HASH"
  # Build with the daemon's own BuildKit (the default `docker` driver), not a
  # throwaway docker-container builder. Its layer cache and the pnpm cache
  # mount live in the daemon and persist across runs on the same host, and the
  # result lands straight in the image store — no OCI tarball export + reload.
  # (CI used `buildx --cache-from/--cache-to type=gha` from a fresh builder per
  # run; `type=gha` needs the Actions runtime token, which a shell step never
  # sees, so every run rebuilt from scratch and spent ~100s exporting/loading.)
  # `--builder default` pins the docker driver even if another job on this
  # host made a docker-container builder current (setup-buildx `use: true`).
  docker buildx build --builder default --load \
    -f Dockerfile.e2e \
    -t coach-e2e-app:local \
    -t "$IMAGE_TAG" \
    .
}

# The image build doesn't depend on the database, so run it alongside
# infra startup + migrate/seed instead of after them.
build_image > >(sed -u 's/^/[image] /') 2>&1 &
BUILD_PID=$!

pnpm e2e:up:infra
pnpm e2e:db:prepare

if ! wait "$BUILD_PID"; then
  echo "=> e2e app image build failed"
  exit 1
fi

# Run containers from the content-hashed tag, not :local — a sibling run can
# retag :local between our build and `up`, which would swap the app under us.
export E2E_APP_IMAGE="$IMAGE_TAG"

if ! docker compose --env-file .env.e2e -p "$E2E_PROJECT" -f docker-compose.e2e.yml up -d --wait app-e2e; then
  echo "=> e2e stack failed to become healthy; dumping worker/app logs"
  docker compose --env-file .env.e2e -p "$E2E_PROJECT" -f docker-compose.e2e.yml logs worker-e2e 2>&1 || true
  docker compose --env-file .env.e2e -p "$E2E_PROJECT" -f docker-compose.e2e.yml logs app-e2e 2>&1 || true
  exit 1
fi
