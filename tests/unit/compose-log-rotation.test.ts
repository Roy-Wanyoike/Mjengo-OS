/**
 * Issue #214 — bounded container logs on EVERY compose service.
 *
 * Docker's default json-file driver retains container stdout/stderr FOREVER
 * unless max-size/max-file cap it — or the daemon's daemon.json sets global
 * defaults, which this repo can neither control nor assume on a self-hoster's
 * host. With restart: unless-stopped, a crash-looping service emits log lines
 * as fast as it restarts (the jobs-tick sidecar prints a timestamped line on
 * every failed drain), which is the classic single-box disk-eater next to the
 * #199 backups — those cover the three stateful volumes, never Docker's own
 * per-container log files under /var/lib/docker/containers. The fix is one
 * block per service:
 *
 *     logging:
 *       driver: json-file
 *       options:
 *         max-size: "10m"
 *         max-file: "3"
 *
 * Pinned here — the CI sandbox has no Docker binary, so this suite is the
 * YAML-level stand-in for the issue's `docker compose config` render check:
 *
 *   · the compose file PARSES (js-yaml load — a YAML syntax error anywhere
 *     in the file fails every test below, exactly like `docker compose
 *     config` refusing to render a broken file);
 *   · THE FENCE: every service in every discovered compose file carries the
 *     exact block — a service added without it (the #214 failure mode, and
 *     the trap a future staging/override compose like #208 could re-open)
 *     fails loudly by name;
 *   · the three issue-named services (app, website, jobs-tick) are present
 *     (superset allowed — a fourth service is fine, an uncapped one is not);
 *   · the values ship with their rationale (the #214 comment in the compose
 *     file) and the DEPLOYMENT.md guidance the issue requires: the caps are
 *     per-compose only, daemon-level defaults cover other host containers.
 *
 * Discovery judgment call: compose files are found by name at the repo root
 * (docker-compose*.yml / compose*.yml) EXCEPT *.override.* — an override is
 * a merge FRAGMENT layered on top of a base file by `docker compose` itself,
 * so a service it re-declares (e.g. just `ports:`) still inherits the base
 * file's logging block; demanding a redundant one there would be a false
 * positive. A new FULL compose file (staging, #208) is discovered and fenced
 * automatically.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The #214 contract, verbatim from the issue's expected behavior. */
const LOG_DRIVER = 'json-file'
const LOG_OPTIONS = { 'max-size': '10m', 'max-file': '3' } as const

/** Compose files at the repo root, override fragments excluded (docblock). */
const COMPOSE_NAME = /^(?:docker-)?compose(?:\.[^.]+)*\.ya?ml$/
const composeFiles = readdirSync(REPO_ROOT)
  .filter((f) => COMPOSE_NAME.test(f) && !f.includes('.override.'))
  .sort()

/** Raw source (for the rationale pins) + parsed docs (for the fence). */
const composeSources = new Map(composeFiles.map((f) => [f, readFileSync(`${REPO_ROOT}/${f}`, 'utf8')]))
const composeDocs = new Map(
  composeFiles.map((f) => [f, load(composeSources.get(f) ?? '', { json: false }) as Record<string, any>]),
)

/** Every service declared by a compose file, as { file, name, service }. */
const declaredServices = composeFiles.flatMap((file) => {
  const services = (composeDocs.get(file)?.services ?? {}) as Record<string, any>
  return Object.entries(services).map(([name, service]) => ({ file, name, service }))
})

// -------------------------------------------- the fence has something to fence

describe('compose discovery (guarding the guard)', () => {
  it('finds at least one compose file — the discovery pattern has not rotted', () => {
    // If this ever fails with zero files, the regex above no longer matches
    // the repo's (renamed) compose files and every fence below went blind.
    expect(composeFiles.length).toBeGreaterThanOrEqual(1)
    expect(composeFiles).toContain('docker-compose.yml')
  })

  it('the three issue-#214 services are all present (superset allowed)', () => {
    const names = declaredServices.filter((s) => s.file === 'docker-compose.yml').map((s) => s.name)
    for (const expected of ['app', 'website', 'jobs-tick']) {
      expect(names, `docker-compose.yml must declare the "${expected}" service`).toContain(expected)
    }
  })
})

// ------------------------------------------------- the #214 fence, per service

describe('every compose service carries the #214 log-rotation block', () => {
  for (const file of composeFiles) {
    describe(file, () => {
      it('parses as YAML with a non-empty services map (the docker compose config stand-in)', () => {
        const doc = composeDocs.get(file)
        expect(doc, 'js-yaml must parse the file (a YAML syntax error fails here)').toBeTruthy()
        expect(doc?.services, 'the file must declare a services map').toBeTypeOf('object')
        expect(Object.keys(doc?.services ?? {})).not.toHaveLength(0)
      })
    })

    for (const { name, service } of declaredServices.filter((s) => s.file === file)) {
      it(`${file}: service "${name}" — json-file driver capped at 10m × 3`, () => {
        // A missing logging block is the exact #214 failure mode; a wrong
        // driver or uncapped options is the same disk-eater one rename away.
        expect(service?.logging, `"${name}" needs a logging: block (issue #214)`).toBeTypeOf('object')
        expect(service.logging.driver, `"${name}" must pin the driver`).toBe(LOG_DRIVER)
        expect(
          service.logging.options,
          `"${name}" must cap size and file count (issue #214: ${JSON.stringify(LOG_OPTIONS)})`,
        ).toMatchObject(LOG_OPTIONS)
      })
    }
  }
})

// --------------------------------------- rationale + docs (more than YAML keys)

describe('the caps ship documented (issue #214 acceptance criteria)', () => {
  it('docker-compose.yml carries the #214 rationale comment alongside the caps', () => {
    const src = composeSources.get('docker-compose.yml') ?? ''
    expect(src, 'the rationale comment must reference the issue').toMatch(/#214/)
  })

  it('one logging block per declared service — none silently missing', () => {
    const src = composeSources.get('docker-compose.yml') ?? ''
    const blocks = src.match(/max-size: "10m"/g) ?? []
    const serviceCount = declaredServices.filter((s) => s.file === 'docker-compose.yml').length
    expect(blocks.length, 'a max-size line per service, no more, no fewer').toBe(serviceCount)
  })

  it('DEPLOYMENT.md documents the caps and the per-compose scope (§6.3 + §7.2 daemon.json note)', () => {
    const md = readFileSync(`${REPO_ROOT}/DEPLOYMENT.md`, 'utf8')
    // The §6.3 note: the values + the per-compose caveat…
    expect(md).toContain('max-size: "10m"')
    expect(md).toContain('per-compose')
    // …and the §7.2 escape hatch for OTHER containers on the host.
    expect(md).toContain('daemon.json')
    expect(md).toContain('max-file')
  })
})
