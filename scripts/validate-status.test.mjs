import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateStatus } from './validate-status.mjs'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const SHA = 'a'.repeat(40)

const good = (over = {}) => ({
	schema: 1,
	project: 'demo',
	overall: 'passed',
	generatedAt: '2026-10-18T08:00:00Z',
	trigger: 'schedule',
	branch: 'main',
	commit: { sha: SHA, short: 'aaaaaaa', url: `https://github.com/o/r/commit/${SHA}` },
	run: { id: '1', url: 'https://github.com/o/r/actions/runs/1' },
	layers: { lint: 'success', ui: 'success' },
	tests: { total: 10, passed: 9, failed: 0, broken: 0, skipped: 1, flaky: 0 },
	links: { report: 'report/', trends: 'report/dashboard/', testHealth: null },
	...over,
})

const check = (status) => validateStatus(status, { now: NOW })

test('a valid status has no problems and no warnings', () => {
	assert.deepEqual(check(good()), { problems: [], warnings: [] })
})

test('trends is optional', () => {
	assert.deepEqual(check(good({ links: { report: 'report/', testHealth: null } })).problems, [])
})

test('a failed run is a warning, not a problem', () => {
	const result = check(good({ overall: 'failed', layers: { lint: 'success', ui: 'failure' } }))
	assert.deepEqual(result.problems, [])
	assert.equal(result.warnings.length, 1)
})

test('rejects anything that is not a JSON object', () => {
	for (const value of [null, 'text', 42, []]) assert.equal(check(value).problems.length, 1)
})

test('rejects the wrong schema version', () => {
	assert.match(check(good({ schema: 2 })).problems[0], /schema/)
})

test('flags a result older than the limit as a problem', () => {
	const result = check(good({ generatedAt: '2026-10-15T08:00:00Z' }))
	assert.ok(result.problems.some((p) => /hours old/.test(p)))
})

test('accepts a result just inside the limit', () => {
	assert.deepEqual(check(good({ generatedAt: '2026-10-17T02:00:00Z' })).problems, [])
})

test('flags a date in the future', () => {
	assert.ok(check(good({ generatedAt: '2026-10-20T00:00:00Z' })).problems.some((p) => /future/.test(p)))
})

test('flags overall that disagrees with the layers', () => {
	const result = check(good({ overall: 'passed', layers: { lint: 'success', ui: 'failure' } }))
	assert.ok(result.problems.some((p) => /overall does not match layers/.test(p)))
})

test('flags counts that do not add up', () => {
	const result = check(good({ tests: { total: 10, passed: 5, failed: 0, broken: 0, skipped: 0, flaky: 0 } }))
	assert.ok(result.problems.some((p) => /does not equal tests.total/.test(p)))
})

test('flags counts that are not numbers', () => {
	assert.ok(check(good({ tests: { total: 'many' } })).problems.some((p) => /tests.total/.test(p)))
})

test('flags links that are not relative', () => {
	for (const report of ['https://evil.example/', '//evil.example/', '/root', '../up', 'javascript:alert(1)']) {
		assert.ok(
			check(good({ links: { report } })).problems.some((p) => /links.report/.test(p)),
			report,
		)
	}
})

test('flags commit and run URLs that are not on github.com', () => {
	const result = check(
		good({
			commit: { sha: SHA, short: 'aaaaaaa', url: 'https://evil.example/c' },
			run: { id: '1', url: 'http://github.com/x' },
		}),
	)
	assert.ok(result.problems.some((p) => /commit.url/.test(p)))
	assert.ok(result.problems.some((p) => /run.url/.test(p)))
})

test('flags a short commit hash that does not match the full one', () => {
	assert.ok(
		check(
			good({ commit: { sha: SHA, short: 'bbbbbbb', url: `https://github.com/o/r/commit/${SHA}` } }),
		).problems.some((p) => /commit.short/.test(p)),
	)
})
