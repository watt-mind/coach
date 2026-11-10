# Use Node.js 22 as the base image
FROM node:24-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV PNPM_CONFIG_IGNORE_SCRIPTS="false"
ENV PNPM_CONFIG_ONLY_BUILT_DEPENDENCIES=""
RUN corepack enable

# Install system dependencies needed for native module builds
RUN apt-get update -y && apt-get install -y python3 make g++ openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Stage 1: Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc* pnpm-workspace.yaml* ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
# Native modules are installed from published prebuilt binaries ONLY. Compiling
# from source is not an automatic fallback here; it is opt-in and validated (see
# ALLOW_NATIVE_SOURCE_BUILD below). See CW-618, and the CW-617 outage it prevents.
#
# better-sqlite3's install script is `prebuild-install || node-gyp rebuild --release`.
# The `||` means ANY failure of the prebuilt download -- including a transient
# `socket hang up` -- silently swaps in a completely different code path: a
# from-source compile against whatever toolchain this image happens to have.
#
# That path does not work here, and it never did. Compiling better-sqlite3 from
# source on this image reproducibly yields a binary that loads and queries fine
# but aborts during Node's environment cleanup:
#
#     node::RemoveEnvironmentCleanupHook ... at ../src/api/hooks.cc:142
#     Assertion failed: (env) != nullptr
#     Statement::~Statement() [.../better_sqlite3.node]      -> exit 134
#
# That is the CW-617 outage, reproduced on demand while verifying CW-618. Because
# the abort happens at process exit rather than at install, the deps layer looked
# healthy and `pnpm build` died minutes later pointing at Node internals; the
# deploy workflow's `cache-to: mode=max` then baked the broken artifact into the
# shared registry cache and every later build inherited it. So the fallback was
# not merely unvalidated -- it could not have produced a working image.
#
# pnpm's `onlyBuiltDependencies` (.npmrc) / `allowBuilds` (pnpm-workspace.yaml)
# allowlists cannot express this policy: they only decide *whether* a package may
# run its install script, not which branch of that script runs. `pnpm rebuild`
# re-runs the same script string. Hence this wrapper, which enforces the policy in
# three independent layers:
#   1. a `node-gyp` guard (via `npm_config_node_gyp` and PATH) turns the silent
#      fallback into a hard, self-explaining failure in seconds. This covers every
#      native dependency, present and future, not just the two named below.
#   2. the prebuilt fetch is retried with backoff, so a genuine network blip costs
#      seconds instead of a red build.
#   3. the installed binaries are asserted prebuilt and then actually exercised,
#      so a broken artifact fails HERE instead of in an unrelated later step.
#
# Side-effect caching is disabled because /pnpm/store is a shared BuildKit cache
# mount: without this, a bad built artifact could survive a `--no-cache` rebuild.
ENV PNPM_CONFIG_SIDE_EFFECTS_CACHE="false"
# Escape hatch, for a future native dependency whose prebuilt binary is genuinely
# unavailable: `--build-arg ALLOW_NATIVE_SOURCE_BUILD=1` permits a from-source
# compile. It is opt-in and logged rather than silent, and the smoke test below
# still gates the layer either way -- the property the original `||` lacked.
#
# It will NOT rescue better-sqlite3. Verified: with this flag set, the compile
# succeeds and the smoke test then aborts with exit 134 exactly as above. That is
# the correct outcome -- a broken binary must not reach the registry cache -- but
# it means the only real fix for a failed prebuilt fetch is to retry the build.
# Never set this as the default.
ARG ALLOW_NATIVE_SOURCE_BUILD=0
RUN --mount=type=cache,id=pnpm-v3,target=/pnpm/store <<'EOS'
set -eu

# --- Layer 1: refuse to compile native modules from source -------------------
if [ "${ALLOW_NATIVE_SOURCE_BUILD}" = "1" ]; then
  echo "WARNING (CW-618): ALLOW_NATIVE_SOURCE_BUILD=1 -- native modules may be compiled"
  echo "from source. This is opt-in and deliberate; the smoke test still gates the layer."
else
  guard_dir="$(mktemp -d)"
  {
    echo '#!/bin/sh'
    echo 'echo "" >&2'
    echo 'echo "ERROR (CW-618): node-gyp was invoked while installing a native dependency." >&2'
    echo 'echo "This image installs native modules from prebuilt binaries only. A from-source" >&2'
    echo 'echo "build of better-sqlite3 on this image reliably produces a binary that aborts" >&2'
    echo 'echo "during Node environment cleanup (exit 134). That was the CW-617 outage, and" >&2'
    echo 'echo "it is why this build refuses to compile rather than quietly falling back." >&2'
    echo 'echo "" >&2'
    echo 'echo "Reaching node-gyp means no prebuilt binary could be obtained, which is almost" >&2'
    echo 'echo "always a transient network failure: RERUN THE BUILD. If it keeps happening," >&2'
    echo 'echo "the prebuilt binary is genuinely missing for this platform/Node ABI, which" >&2'
    echo 'echo "needs a real decision -- see ALLOW_NATIVE_SOURCE_BUILD in the Dockerfile." >&2'
    echo 'exit 1'
  } > "$guard_dir/node-gyp"
  chmod +x "$guard_dir/node-gyp"
  # Two interception points are needed, and neither alone is sufficient:
  #   * `npm_config_node_gyp` is what pnpm's lifecycle runner honours. pnpm bundles
  #     its own node-gyp and injects it, so a bare PATH entry is ignored -- this is
  #     the one that catches better-sqlite3's `|| node-gyp rebuild --release`.
  #   * PATH catches packages that shell out to `node-gyp` directly, which is what
  #     bcrypt's `node-gyp-build` does (node-gyp is not in its dependency tree).
  npm_config_node_gyp="$guard_dir/node-gyp"
  PATH="$guard_dir:$PATH"
  export npm_config_node_gyp PATH
fi

# --- Layer 0: assert the side-effect cache really is off ---------------------
# PNPM_CONFIG_SIDE_EFFECTS_CACHE is an env-var spelling of pnpm's
# `side-effects-cache` setting. If a future pnpm renames or drops it, the ENV
# above becomes a silent no-op and the shared /pnpm/store cache mount quietly
# turns back into a way for a bad built artifact to outlive a `--no-cache`
# rebuild. Silent is the failure mode this whole file exists to remove, so check
# it. (`undefined` here means "not set" -- i.e. the env var did not take.)
side_effects_cache="$(pnpm config get side-effects-cache 2>/dev/null | tail -n 1)"
if [ "$side_effects_cache" != "false" ]; then
  echo "ERROR (CW-618): expected pnpm side-effects-cache=false, got '${side_effects_cache}'." >&2
  echo "PNPM_CONFIG_SIDE_EFFECTS_CACHE no longer maps to that setting. Find its current" >&2
  echo "name and update the ENV, or a bad native binary can survive a --no-cache build." >&2
  exit 1
fi

pnpm install --frozen-lockfile --ignore-scripts

# --- Layer 2: retry the prebuilt fetch before giving up ----------------------
attempt=1
until pnpm rebuild better-sqlite3 bcrypt; do
  if [ "$attempt" -ge 3 ]; then
    echo "ERROR (CW-618): prebuilt native binaries could not be installed after ${attempt} attempts." >&2
    exit 1
  fi
  echo "Prebuilt native binary install failed (attempt ${attempt} of 3); retrying..." >&2
  sleep "$((attempt * 5))"
  attempt="$((attempt + 1))"
done

# --- Layer 3a: assert the artifacts are prebuilt, not compiled ---------------
# Defence in depth behind the guard above, in case a package ever reaches gyp
# by some route neither hook covers. node-gyp leaves build/Makefile,
# build/config.gypi and build/Release/obj.target; prebuild-install and
# node-gyp-build never create any of them.
if [ "${ALLOW_NATIVE_SOURCE_BUILD}" != "1" ]; then
  for pkg in better-sqlite3 bcrypt; do
    if [ -e "node_modules/${pkg}/build/Makefile" ] \
      || [ -e "node_modules/${pkg}/build/config.gypi" ] \
      || [ -d "node_modules/${pkg}/build/Release/obj.target" ]; then
      echo "ERROR (CW-618): ${pkg} was compiled from source; refusing to build this layer." >&2
      exit 1
    fi
  done
fi

# --- Layer 3b: prove the binaries actually work ------------------------------
node -e "
  const Database = require('better-sqlite3');
  const closed = new Database(':memory:');
  if (closed.prepare('select 1 as ok').get().ok !== 1) throw new Error('better-sqlite3 returned an unexpected result');
  closed.close();
  // Deliberately left open: the CW-617 binary aborted in a Statement destructor
  // during Node's environment cleanup, which only runs at process exit.
  const open = new Database(':memory:');
  open.prepare('select 1 as ok').get();
  const bcrypt = require('bcrypt');
  if (!bcrypt.compareSync('cw-618', bcrypt.hashSync('cw-618', 4))) throw new Error('bcrypt hash/compare roundtrip failed');
  console.log('native dependency smoke test: ok');
"

pnpm prisma generate

if [ -n "${guard_dir:-}" ]; then rm -rf "$guard_dir"; fi
EOS

# Stage 2: Build the application
FROM base AS builder
ARG COMMIT_SHA
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV COMMIT_SHA=${COMMIT_SHA}
ENV SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}
# Nuxt evaluates its Sentry module configuration during `pnpm build`.
ENV NODE_ENV=production
ENV CHAT_TURN_RUNNER_ENABLED=false
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Typecheck is NOT run here: the CI workflow (.github/workflows/ci.yml) runs it on a
# GitHub-hosted runner and gates the deploy job, so it fails minutes earlier and we
# don't pay for it twice per push. Run `pnpm typecheck` locally before building by hand.
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm build

# Stage 3: Production image
FROM base AS runner
ENV NODE_ENV=production

# Copy built application
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/app/emails ./app/emails
COPY --from=builder /app/app/utils ./app/utils
COPY --from=builder /app/cli ./cli
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/trigger ./trigger
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/start.sh ./start.sh

# Make start.sh executable
RUN chmod +x ./start.sh

# Expose the port the app runs on
EXPOSE 3000

# Default command
CMD ["./start.sh"]
