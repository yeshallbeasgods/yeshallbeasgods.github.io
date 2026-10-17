// Checks that every live project in projects.json publishes a valid, fresh status.json.
//   node scripts/validate-status.mjs [--stale-after-hours=36]
// Exits 1 if any project has a problem. A project whose latest test run FAILED is only a warning: its own CI
// reports test failures. This check is about whether results are being published correctly and on time.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Keep in sync with STALE_AFTER_HOURS in app.js.
export const STALE_AFTER_HOURS = 36

const COUNT_KEYS = ['total', 'passed', 'failed', 'broken', 'skipped', 'flaky']
const GITHUB_URL = /^https:\/\/github\.com\//

const isText = (value) => typeof value === 'string' && value.length > 0
const isCount = (value) => Number.isInteger(value) && value >= 0
const isRelative = (value) => isText(value) && !value.includes(':') && !value.startsWith('/') && !value.includes('..')

// Pure function, so it can be unit tested. Returns the problems and warnings found in one parsed status.json.
export function validateStatus(status, { now = Date.now(), staleAfterHours = STALE_AFTER_HOURS } = {}) {
	const problems = []
	const warnings = []
	if (!status || typeof status !== 'object' || Array.isArray(status)) {
		return { problems: ['status.json is not a JSON object'], warnings }
	}

	if (status.schema !== 1) problems.push(`schema is ${JSON.stringify(status.schema)}, expected 1`)
	for (const key of ['project', 'trigger', 'branch']) {
		if (!isText(status[key])) problems.push(`${key} is missing`)
	}
	if (!['passed', 'failed'].includes(status.overall)) problems.push('overall must be "passed" or "failed"')

	const generated = Date.parse(status.generatedAt)
	if (Number.isNaN(generated)) {
		problems.push('generatedAt is not a valid date')
	} else {
		const ageHours = (now - generated) / 3_600_000
		if (ageHours > staleAfterHours) {
			problems.push(
				`result is ${Math.round(ageHours)} hours old (limit ${staleAfterHours}); the nightly run may be broken`,
			)
		}
		if (ageHours < -1) problems.push('generatedAt is in the future')
	}

	const sha = status.commit?.sha
	if (!/^[0-9a-f]{40}$/.test(sha ?? '')) problems.push('commit.sha is not a 40-character hex string')
	else if (status.commit.short !== sha.slice(0, 7)) problems.push('commit.short does not match commit.sha')
	if (!GITHUB_URL.test(status.commit?.url ?? '')) problems.push('commit.url is not a github.com URL')
	if (!GITHUB_URL.test(status.run?.url ?? '')) problems.push('run.url is not a github.com URL')

	const layers = Object.entries(status.layers ?? {})
	if (layers.length === 0) problems.push('layers is empty')
	if (layers.some(([, result]) => !isText(result))) problems.push('a layer result is not text')
	const allSuccess = layers.length > 0 && layers.every(([, result]) => result === 'success')
	if ((status.overall === 'passed') !== allSuccess) problems.push('overall does not match layers')

	const t = status.tests ?? {}
	for (const key of COUNT_KEYS) {
		if (!isCount(t[key])) problems.push(`tests.${key} is not a non-negative integer`)
	}
	if (COUNT_KEYS.every((key) => isCount(t[key])) && t.passed + t.failed + t.broken + t.skipped !== t.total) {
		problems.push('tests.passed + failed + broken + skipped does not equal tests.total')
	}

	if (!isRelative(status.links?.report)) problems.push('links.report must be a relative path')
	if (status.links?.trends != null && !isRelative(status.links.trends)) {
		problems.push('links.trends must be a relative path')
	}

	if (status.overall === 'failed') warnings.push('latest run failed (the project reports its own test failures)')
	return { problems, warnings }
}

// ---------- command line ----------

// Workflow commands are escaped so text from a remote file can never inject another command.
const escapeCommand = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const cell = (text) => String(text).replace(/[|\r\n]/g, ' ')

async function checkProject(project, staleAfterHours) {
	const base = project.site.endsWith('/') ? project.site : `${project.site}/`
	const result = { id: project.id, problems: [], warnings: [], summary: '' }
	try {
		const response = await fetch(new URL('status.json', base), {
			cache: 'no-store',
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) {
			result.problems.push(`status.json returned HTTP ${response.status}`)
			return result
		}
		if (!response.headers.get('access-control-allow-origin')) {
			result.problems.push('status.json has no access-control-allow-origin header, so the hub cannot read it')
		}
		const status = await response.json()
		const { problems, warnings } = validateStatus(status, { staleAfterHours })
		result.problems.push(...problems)
		result.warnings.push(...warnings)
		if (problems.length === 0) {
			result.summary = `${status.overall}, ${status.tests.passed}/${status.tests.total} tests`
			const report = await fetch(new URL(status.links.report, base), { signal: AbortSignal.timeout(10_000) })
			if (!report.ok) result.problems.push(`links.report returned HTTP ${report.status}`)
		}
	} catch (error) {
		result.problems.push(`could not fetch or parse status.json (${error.message})`)
	}
	return result
}

async function main() {
	const arg = process.argv.find((a) => a.startsWith('--stale-after-hours='))
	const staleAfterHours = arg ? Number(arg.split('=')[1]) : STALE_AFTER_HOURS

	const here = path.dirname(fileURLToPath(import.meta.url))
	const { projects } = JSON.parse(fs.readFileSync(path.join(here, '..', 'projects.json'), 'utf8'))
	const live = projects.filter((project) => project.site)
	const results = await Promise.all(live.map((project) => checkProject(project, staleAfterHours)))

	const inActions = Boolean(process.env.GITHUB_ACTIONS)
	const rows = ['| Project | Result | Details |', '| --- | --- | --- |']
	for (const r of results) {
		const state = r.problems.length ? 'PROBLEM' : r.warnings.length ? 'warning' : 'ok'
		console.log(`${state.padEnd(8)} ${r.id}${r.summary ? `  (${r.summary})` : ''}`)
		for (const text of [...r.problems, ...r.warnings]) console.log(`           - ${text}`)
		if (inActions) {
			for (const text of r.problems) console.log(`::error title=${escapeCommand(r.id)}::${escapeCommand(text)}`)
			for (const text of r.warnings) console.log(`::warning title=${escapeCommand(r.id)}::${escapeCommand(text)}`)
		}
		rows.push(
			`| ${cell(r.id)} | ${state} | ${cell([r.summary, ...r.problems, ...r.warnings].filter(Boolean).join('; '))} |`,
		)
	}
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join('\n')}\n`)

	const failed = results.filter((r) => r.problems.length).length
	console.log(`\n${results.length} live project(s) checked, ${failed} with problems`)
	process.exitCode = failed ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main()
}
