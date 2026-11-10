#!/usr/bin/env node
/**
 * Prune old GHCR container image versions.
 *
 * Every deploy pushes an image tagged with the commit SHA, and nothing ever
 * removed the old ones -- 339 versions had accumulated. GHCR shares its storage
 * pool with GitHub Actions artifacts, so once it filled up, artifact uploads
 * started failing in unrelated workflows, on green runs (CW-711).
 *
 * Two things make the obvious "delete all untagged versions" recipe wrong:
 *
 *  1. A tag is an OCI *index*. Its per-arch image and (unless disabled)
 *     provenance attestation are separate package versions that carry no tags
 *     of their own. Deleting those "untagged" versions destroys the live tag.
 *     So we resolve each kept tag's manifest and protect its children.
 *
 *  2. This repo tags images `sha-<40hex>` (docker/metadata-action
 *     `type=sha,format=long`) and keeps a live `buildcache` tag written by
 *     `cache-to: type=registry,mode=max`. The rule is therefore inverted: a
 *     version is only a deletion candidate when *every* tag on it looks like a
 *     per-commit SHA. Anything else -- latest, master, develop, buildcache,
 *     semver -- is protected, so an unrecognised scheme fails safe rather than
 *     being deleted. Deleting `buildcache` would not break a deploy, but it
 *     would silently throw away the layer cache.
 *
 * Usage:
 *   node scripts/ghcr-prune.mjs --package coach
 *   node scripts/ghcr-prune.mjs --package coach --keep 5 --apply
 *
 * Without --apply it only reports. Requires GH_TOKEN with delete:packages
 * (or a workflow GITHUB_TOKEN with `packages: write`).
 */

const ORG = process.env.GHCR_ORG || "watt-mind";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GH_TOKEN (or GITHUB_TOKEN) is required");
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const KEEP = Number(valueOf("--keep") ?? 5);
const PACKAGES = args.reduce((acc, a, i) => {
  if (a === "--package" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);
if (PACKAGES.length === 0) {
  console.error("at least one --package <name> is required");
  process.exit(1);
}

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const SHA_TAG = [/^[0-9a-f]{40}$/, /^sha-[0-9a-f]{40}$/, /^sha256-[0-9a-f]{64}$/];
const isShaTag = (t) => SHA_TAG.some((re) => re.test(t));
const tagsOf = (v) => v?.metadata?.container?.tags ?? [];

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  return res;
}

async function listVersions(pkg) {
  const enc = encodeURIComponent(pkg);
  const out = [];
  for (let page = 1; ; page++) {
    const res = await gh(
      `/orgs/${ORG}/packages/container/${enc}/versions?per_page=100&page=${page}`,
    );
    if (!res.ok) throw new Error(`${pkg}: list failed ${res.status} ${await res.text()}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

/** Anonymous-ish pull token for the registry, needed to read manifests. */
async function registryToken(repo) {
  const basic = Buffer.from(`x:${TOKEN}`).toString("base64");
  const res = await fetch(
    `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
    { headers: { Authorization: `Basic ${basic}` } },
  );
  if (!res.ok) throw new Error(`registry token failed for ${repo}: ${res.status}`);
  return (await res.json()).token;
}

/** Child manifest digests of an index; empty for a plain manifest. */
async function childrenOf(repo, rtok, digest) {
  const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${digest}`, {
    headers: {
      Authorization: `Bearer ${rtok}`,
      Accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(","),
    },
  });
  if (!res.ok) return [];
  const m = await res.json();
  return (m.manifests ?? []).map((c) => c.digest);
}

let totalDeleted = 0;
let totalFailed = 0;

for (const pkg of PACKAGES) {
  const repo = `${ORG}/${pkg}`;
  const versions = await listVersions(pkg);
  const present = new Set(versions.map((v) => v.name));

  const keep = new Set();
  const shaOnly = [];
  for (const v of versions) {
    const tags = tagsOf(v);
    if (tags.length === 0) continue; // untagged: decided by its parent below
    if (tags.every(isShaTag)) shaOnly.push(v);
    else keep.add(v.name); // any named tag => protected
  }
  shaOnly.sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const v of shaOnly.slice(0, KEEP)) keep.add(v.name);

  const rtok = await registryToken(repo);
  for (const digest of [...keep]) {
    for (const child of await childrenOf(repo, rtok, digest)) {
      if (present.has(child)) keep.add(child);
    }
  }

  const doomed = versions.filter((v) => !keep.has(v.name));
  console.log(
    `${pkg}: ${versions.length} versions, keeping ${keep.size}, ${APPLY ? "deleting" : "would delete"} ${doomed.length}`,
  );
  if (!APPLY) continue;

  const enc = encodeURIComponent(pkg);
  for (const v of doomed) {
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const res = await gh(
        `/orgs/${ORG}/packages/container/${enc}/versions/${v.id}`,
        { method: "DELETE" },
      );
      if (res.ok || res.status === 404) {
        done = true;
        totalDeleted++;
      } else if (res.status === 403 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 20_000 * attempt)); // secondary rate limit
      } else {
        totalFailed++;
        console.error(`  ! ${pkg} ${v.id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
        done = true;
      }
    }
    await new Promise((r) => setTimeout(r, 120)); // stay under secondary limits
  }
}

console.log(
  APPLY
    ? `done: deleted=${totalDeleted} failed=${totalFailed}`
    : "dry run — pass --apply to delete",
);
if (totalFailed > 0) process.exit(1);
