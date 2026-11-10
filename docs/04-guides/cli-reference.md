# Coach Watts CLI Reference

The Coach Watts project provides two primary CLI tools for development, debugging, and operational tasks: `cw:cli` for general administration and `cw:worker` for background process management.

## Philosophy

- **Centralization**: All utility scripts are integrated into the CLI to prevent "script sprawl."
- **Consistency**: The CLI uses the same environment variables, database connections, and utilities as the main application.
- **Discoverability**: Commands are self-documenting via `--help`.
- **Production Safety**: Destructive or production-facing commands typically require an explicit `--prod` flag.

---

## 🚀 `cw:cli` - General Administration

The `cw:cli` command is the main entry point for most administrative and debugging tasks.

### Basic Usage

```bash
pnpm cw:cli <command> [subcommand] [options]
```

### Core Command Groups

#### Partner campaigns (`partners`)

Manage time-limited partner promotional access and attached public events.

- `create [--event-slug ...] [--prod --confirm-prod] [--dry-run]`: Create a campaign.
- `list [--prod]`: List campaigns with aggregate redemption counts.
- `show <slug> [--prod]`: Inspect one campaign, events, and public URLs.
- `attach-event <campaign> <event> [--primary] [--prod --confirm-prod]`
- `detach-event <campaign> <event> [--prod --confirm-prod]`
- `disable <slug> [--prod --confirm-prod]`: Stop new redemptions.
- `update-capacity <slug> [--max-redemptions N] [--enable] [--prod --confirm-prod]`
- `user-grant <email-or-id> [--prod]`: Inspect a user's promotional grant for support.

#### Public events (`events`)

Canonical organizer event catalog (not athlete-owned Events).

- `create --slug ... --title ... --organizer-name ... --date YYYY-MM-DD [--published] [--upsert] [--prod --confirm-prod] [--dry-run]`
- `show|list|update|publish|unpublish`

Production writes require both `--prod` and `--confirm-prod`. See [partner-campaigns.md](./partner-campaigns.md).

#### 1. Database (`db`)

Manage database operations, backups, and schema diagnostics.

- `backup`: Create a database backup.
- `compare`: Check for schema drift between development and production.
- `migrate-zones`: Migrate user heart rate/power zones.
- `seed`: Seed the database with initial or test data.
- `sql`: Execute raw SQL queries directly from the CLI.
- `workout`: Database operations specifically for workout data maintenance.

#### 2. Users (`users`)

Manage user accounts, statistics, and quotas.

- `search <query> [--prod]`: Search for users by email, name, or ID.
- `stats`: View registration and activity statistics.
- `admins`: Manage administrative user status.
- `contributor add <email> [--prod]`: Grant lifetime Pro access (`subscriptionStatus: CONTRIBUTOR`). Stripe sync skips these users.
- `contributor remove <email> [--prod]`: Revoke lifetime access and downgrade to Free.
- `location`: Manage user countries based on last login IP.
- `quota`: View or manage user AI/API usage quotas.
- `reset-quota`: Reset usage quotas for specific users.
- `data export|api-pull|import`: Export a user universe to a file and import it as a new user.
- `data transfer`: Selectively copy a user's data from one instance's database onto an existing user in another (prod → testing). See [Data Management](./data-management.md#developer-workflow-prod-to-testing-transfer).

#### 2b. Subscriptions (`subscriptions`)

Audit and reconcile Stripe subscription state.

- `list [--prod]`: List users with subscription data.
- `sync [--prod] [--fix] [--email <email>]`: Compare DB subscription fields against Stripe. Users with `CONTRIBUTOR` status are skipped. Use `--fix` to apply Stripe state to the database.

> **Warning:** Do not use `debug subscription set ... ACTIVE` for complimentary or lifetime access — Stripe webhooks and sync will overwrite it. Use `users contributor add` or the admin user page instead.

#### 3. Trigger.dev (`trigger`)

Monitor and manually trigger background tasks.

- `list [--limit <n>] [--status <status>] [--prod]`: List recent background job runs.
- `get <runId> [--prod]`: View detailed status and logs for a specific run.
- `checkin <email> [--prod]`: Manually trigger the daily check-in generation for a user.
- `workout`: Trigger workout-related analysis tasks.

#### 4. Backfill & Data Integrity (`backfill`)

A large collection of specialized scripts for fixing data issues, migrating schemas, and performing bulk updates.

- `metrics`, `tss`, `kilojoules`: Recalculate training metrics.
- `planned-workouts`, `workouts`: Fix or update workout records.
- `intervals-parsing`, `max-watts`: Fix specific data parsing errors.
- `profile`, `wellness-oura`, `plan-indices`: Sync or fix user profile/wellness/plan data.
- `chat-rooms`: Maintain or migrate chat room data.

#### 5. Nutrition & Metabolism (`nutrition`)

Deep debugging and analysis of nutrition data and metabolic calculations.

- `day-log`: View nutrition logs for a specific day.
- `metabolic`: Analyze BMR, TDEE, and carb targets.
- `fueling-workout`: Analyze fueling plans for specific workouts.
- `compare-fueling`: Compare planned vs. actual fueling.

#### 6. Debugging & Health (`debug`, `check`, `monitor`)

- `debug env`: Verify environment variables (masked).
- `debug ping`: Test external URL connectivity.
- `debug workout-facts --id <uuid> [--json] [--prod]`: Compute the shared workout analysis facts payload used for workout-detail debugging.
- `check env`: Validates the local `.env` setup.
- `monitor [--prod]`: Checks the `/api/health` and Trigger.dev status endpoints.

#### 7. Integrations (`oura`, `polar`, `oauth`, `garmin`)

- `oura`: Manage Oura integration settings and data sync.
- `polar`: Manage Polar integration settings and data sync.
- `oauth`: Manage OAuth 2.0 Provider and client registrations.
- `debug garmin-test <userEmailOrId> [--prod]`: Run comprehensive Garmin OAuth PKCE, Token Refresh, Health API, and Push Ingestion diagnostic test suite.
- `debug garmin-ingest <userEmailOrId> [--prod] [--days N] [--backfill]`: Test direct pull data sync or trigger Garmin Health API backfill for a user.
- `debug webhook garmin [--prod] [--external-user <id>] [--type activities|dailies|sleeps|hrv]`: Send simulated Garmin push webhook events.
- `debug garmin-training-inspect <userEmailOrId> [--prod]`: Inspect stored Garmin workouts, streams, and raw FIT files.

#### 8. Translations (`translations`)

Manage i18n keys and namespaces across the Tolgee platform. Requires `TOLGEE_API_URL` and `TOLGEE_API_KEY` in `.env`.

- `sync-all [--dry-run]`: **One-command workflow** — pushes all English namespace values (creating any missing keys automatically), checks every JSON file is registered in `tolgee.ts` staticData, then pulls all translations. Use this for any routine sync after adding or changing keys.
- `check [--patterns <globs>]`: Two-part check — (1) verifies all `useTranslate('ns')` namespaces are registered in `app/plugins/tolgee.ts` staticData; (2) runs `tolgee extract check` for extraction warnings.
- `list-missing [--patterns <globs>] [--namespace <ns>]`: Compares keys found in code against the Tolgee platform and lists any that are missing. Groups output by namespace.
- `status`: Shows a per-language coverage table — which namespaces have JSON files and which are missing.
- `push-values --namespace <ns> [--dry-run]`: Reads `app/i18n/en/<ns>.json` and pushes every key's English value to the platform. Auto-creates keys that don't exist yet. Use for a single namespace.
- `sync [--patterns <globs>] [--dry-run]`: Runs `tolgee sync` to create key stubs on the platform with the correct namespace (reads namespace from `useTranslate()` in code). Safer than `pnpm i18n:push` for new namespaces.
- `untranslated [--lang <codes>] [--namespace <ns>]`: Lists all keys that are missing translations on the platform. Groups output by language then namespace. `--lang` accepts comma-separated codes (e.g. `de,fr`); defaults to all non-English languages.

**Routine sync (after adding or changing any keys):**

```bash
cw:cli translations sync-all
```

**Typical workflow for a new page:**

```bash
# 1. Create app/i18n/en/<ns>.json, add useTranslate('<ns>') to the component
# 2. Register the namespace in app/plugins/tolgee.ts staticData
cw:cli translations sync-all      # push all English values, check registration, pull
```

---

## 🛠️ `cw:worker` - Webhook Worker

The worker CLI manages the background process that listens to incoming webhooks (e.g., from Strava, Intervals.icu, Oura).

### Commands

- `start`: Starts the webhook listener process.
- `status`: Displays the current state of the processing queues (pending, active, completed jobs).
- `ping [--count <n>] [--concurrency <c>]`: Adds test jobs to the queue to verify the worker is active.

### Local development

Use `pnpm dev:worker` rather than `pnpm cw:worker start` while developing — it is the same
entrypoint with file watching and an explicit `NODE_ENV=development`.

`cw:worker` still works: `cli/worker/cli.ts` defaults `NODE_ENV` to `development` when it is
unset and warns on stderr when it does. That default exists because the realtime and chat
Redis pub/sub channels are namespaced per instance only when `NODE_ENV=development` — a
worker with an unset `NODE_ENV` would publish to the shared `app:realtime` channel while the
dev server listens on the namespaced one, and every event would be dropped silently with no
log. An explicit `NODE_ENV` is never overridden, so deployed workers (`NODE_ENV=production`
via the `Dockerfile` / compose files) are unaffected. Set `REALTIME_CHANNEL_NAMESPACE` in
`.env` to pin the namespace regardless of `NODE_ENV`.

---

## 🛠️ Extending the CLI

To add a new command group:

1.  Create a new directory in `cli/`.
2.  Add an `index.ts` to export a `commander` `Command`.
3.  Register the group in `cli/index.ts`.

### Example Structure

```
cli/
├── my-group/
│   ├── index.ts      # Define 'my-group' command
│   ├── sub-task.ts   # Define 'my-group sub-task'
└── index.ts          # Register my-group
```

## Best Practices

1. **Always verify with `--help`**: Commands evolve quickly.
2. **Use `--prod` with caution**: Most commands that can modify data will default to development unless `--prod` is passed.
3. **Piping**: CLI output is designed to be greppable.
4. **Maintenance**: **IMPORTANT**: Maintain this document whenever updating the CLI or discovering issues/new commands. It is referenced in `GEMINI.md` and `RULES.md`.
