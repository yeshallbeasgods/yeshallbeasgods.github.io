// Reads projects.json, then fetches each live project's status.json in the visitor's browser and renders a tile.
// Nothing here uses innerHTML: every value that comes from a remote file is inserted as text, and links are
// checked before they are used. The status format is documented in README.md.

// Nightly runs should land about every 24 hours. This leaves slack for a late schedule before flagging "stale".
const STALE_AFTER_HOURS = 36
const FETCH_TIMEOUT_MS = 8000
const THEME_KEY = 'hub-theme'
// Joined in the browser so the address is not sitting in the HTML for simple scrapers. This is not real protection.
const EMAIL_PARTS = ['iamrobertprobst', 'gmail.com']

const GITHUB_URL = /^https:\/\/github\.com\//
const CHIP_TEXT = {
	passed: 'Passing',
	failed: 'Failing',
	stale: 'Stale',
	unavailable: 'Unavailable',
	asleep: 'Asleep',
	docs: 'Docs',
	loading: 'Loading',
}

// ---------- small helpers ----------

function h(tag, props = {}, ...children) {
	const element = document.createElement(tag)
	for (const [key, value] of Object.entries(props)) {
		if (value == null || value === false) continue
		if (key === 'class') element.className = value
		else if (key === 'text') element.textContent = value
		else element.setAttribute(key, value)
	}
	for (const child of children) {
		if (child) element.append(child)
	}
	return element
}

const isText = (value) => typeof value === 'string' && value.length > 0
const isCount = (value) => Number.isInteger(value) && value >= 0

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
function ago(date) {
	const seconds = Math.round((date.getTime() - Date.now()) / 1000)
	for (const [unit, size] of [
		['day', 86400],
		['hour', 3600],
		['minute', 60],
	]) {
		if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit)
	}
	return 'just now'
}

// A relative path from a status file is only trusted if it stays inside that project's own site.
function resolveInside(site, relative) {
	if (!isText(relative) || relative.includes(':') || relative.startsWith('/') || relative.includes('..')) return null
	const url = new URL(relative, site)
	return url.href.startsWith(site) ? url.href : null
}

// ---------- status files ----------

function parseStatus(raw, site) {
	if (!raw || raw.schema !== 1) return null
	const generatedAt = new Date(raw.generatedAt)
	if (Number.isNaN(generatedAt.getTime()) || !['passed', 'failed'].includes(raw.overall)) return null
	const t = raw.tests ?? {}
	if (!['total', 'passed', 'failed', 'broken', 'skipped'].every((key) => isCount(t[key]))) return null

	return {
		overall: raw.overall,
		generatedAt,
		trigger: isText(raw.trigger) ? raw.trigger : 'unknown',
		tests: {
			total: t.total,
			passed: t.passed,
			failed: t.failed + t.broken,
			skipped: t.skipped,
			flaky: isCount(t.flaky) ? t.flaky : 0,
		},
		layers: Object.entries(raw.layers ?? {})
			.filter(([, result]) => isText(result))
			.map(([name, result]) => ({ name, result, ok: result === 'success' })),
		commit: isText(raw.commit?.short) ? raw.commit.short.slice(0, 7) : null,
		links: {
			report: resolveInside(site, raw.links?.report),
			trends: resolveInside(site, raw.links?.trends),
			commit: GITHUB_URL.test(raw.commit?.url ?? '') ? raw.commit.url : null,
			run: GITHUB_URL.test(raw.run?.url ?? '') ? raw.run.url : null,
		},
	}
}

async function fetchStatus(site) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const response = await fetch(new URL('status.json', site), { cache: 'no-store', signal: controller.signal })
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const status = parseStatus(await response.json(), site)
		if (!status) throw new Error('unexpected format')
		return { status }
	} catch (error) {
		return { error: error.name === 'AbortError' ? 'timed out' : error.message }
	} finally {
		clearTimeout(timer)
	}
}

function stateOf(result) {
	if (result.error) return 'unavailable'
	const ageHours = (Date.now() - result.status.generatedAt.getTime()) / 3_600_000
	return ageHours > STALE_AFTER_HOURS ? 'stale' : result.status.overall
}

// ---------- rendering ----------

const chip = (state) => h('span', { class: 'chip', 'data-state': state, text: CHIP_TEXT[state] })
const button = (label, href, primary = false) =>
	href ? h('a', { class: primary ? 'button primary' : 'button', href, rel: 'noopener', text: label }) : null
const tags = (project) => h('ul', { class: 'tags' }, ...project.tags.map((tag) => h('li', { text: tag })))

function tile(project, state) {
	const body = h('div', { class: 'tile-body' })
	const element = h(
		'article',
		{ class: state === 'asleep' ? 'tile asleep' : 'tile' },
		h(
			'div',
			{ class: 'tile-head' },
			h('div', {}, h('h3', { text: project.title }), h('p', { class: 'subtitle', text: project.subtitle })),
			chip(state),
		),
		h('p', { class: 'summary-text', text: project.summary }),
		tags(project),
		body,
	)
	return { element, body }
}

function fact(label, value, tone) {
	return h('div', {}, h('dt', { text: label }), h('dd', { class: tone, text: value }))
}

function renderLive(body, project, result, state) {
	body.replaceChildren()
	if (result.error) {
		body.append(
			h('p', { class: 'summary-text', text: `Could not load the latest results (${result.error}).` }),
			h(
				'div',
				{ class: 'actions' },
				button('Open the site', project.site, true),
				button('Repository', project.repo),
			),
		)
		return
	}

	const { status } = result
	const t = status.tests
	const testText =
		t.failed > 0 ? `${t.failed} failed, ${t.passed} of ${t.total} passed` : `${t.passed} of ${t.total} passed`
	const extras = [t.skipped ? `${t.skipped} skipped` : '', t.flaky ? `${t.flaky} flaky` : ''].filter(Boolean)
	const trigger = status.trigger === 'schedule' ? 'nightly run' : status.trigger.replace('_', ' ')

	body.append(
		h(
			'dl',
			{ class: 'facts' },
			fact('Tests', testText + (extras.length ? ` (${extras.join(', ')})` : ''), t.failed > 0 ? 'bad' : 'ok'),
			fact('Last run', ago(status.generatedAt), state === 'stale' ? 'warn' : undefined),
			fact('Trigger', trigger),
		),
		h(
			'ul',
			{ class: 'layers', 'aria-label': 'Results by stage' },
			...status.layers.map((layer) =>
				h('li', { class: layer.ok ? 'ok' : 'bad', text: `${layer.name}: ${layer.result}` }),
			),
		),
	)
	if (state === 'stale') {
		body.append(
			h('p', {
				class: 'summary-text',
				text: `Last known result was ${status.overall}. No run in over ${STALE_AFTER_HOURS} hours, and the nightly run should land daily.`,
			}),
		)
	}
	body.append(
		h(
			'div',
			{ class: 'actions' },
			button('Report', status.links.report ?? project.site, true),
			button('Trends', status.links.trends),
			button(status.commit ? `Commit ${status.commit}` : 'Commit', status.links.commit),
			button('CI run', status.links.run),
			button('Repository', project.repo),
		),
	)
}

function renderStatic(body, project, label) {
	body.append(h('div', { class: 'actions' }, button(label, project.repo, project.kind === 'docs')))
}

function renderSummary(results) {
	const loaded = results.filter((r) => r.status)
	const states = results.map(stateOf)
	const count = (state) => states.filter((s) => s === state).length
	const parts = [`${results.length} live project${results.length === 1 ? '' : 's'}`, `${count('passed')} passing`]
	for (const [state, word] of [
		['failed', 'failing'],
		['stale', 'stale'],
		['unavailable', 'unavailable'],
	]) {
		if (count(state)) parts.push(`${count(state)} ${word}`)
	}
	const passed = loaded.reduce((sum, r) => sum + r.status.tests.passed, 0)
	const total = loaded.reduce((sum, r) => sum + r.status.tests.total, 0)
	if (total) parts.push(`${passed} of ${total} tests passing`)
	const latest = loaded.map((r) => r.status.generatedAt).sort((a, b) => b - a)[0]
	if (latest) parts.push(`latest run ${ago(latest)}`)
	document.getElementById('summary').textContent = parts.join('  ·  ')
}

// ---------- page setup ----------

function initTheme() {
	const toggle = document.getElementById('theme-toggle')
	const apply = (theme) => {
		document.documentElement.dataset.theme = theme
		toggle.setAttribute('aria-pressed', String(theme === 'light'))
	}
	apply(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
	toggle.addEventListener('click', () => {
		const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
		apply(next)
		try {
			localStorage.setItem(THEME_KEY, next)
		} catch {
			// Storage can be blocked (private windows, strict settings). The toggle still works for this visit.
		}
	})
}

function initEmail() {
	const link = document.getElementById('email-link')
	link.href = `mailto:${EMAIL_PARTS.join('@')}`
	link.hidden = false
}

async function main() {
	initTheme()
	initEmail()

	let projects
	try {
		const response = await fetch('projects.json')
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		projects = (await response.json()).projects
	} catch (error) {
		document.getElementById('summary').textContent = `Could not load the project list (${error.message}).`
		return
	}

	const live = []
	for (const project of projects) {
		if (project.kind === 'docs') {
			const { element, body } = tile(project, 'docs')
			renderStatic(body, project, 'Read the notes')
			document.getElementById('notes-grid').append(element)
		} else if (project.site) {
			const { element, body } = tile(project, 'loading')
			document.getElementById('live-grid').append(element)
			live.push({ project, element, body })
		} else {
			const { element, body } = tile(project, 'asleep')
			body.append(h('p', { class: 'summary-text', text: 'Live results are coming.' }))
			renderStatic(body, project, 'Repository')
			document.getElementById('asleep-grid').append(element)
		}
	}

	const results = await Promise.all(
		live.map(async ({ project, element, body }) => {
			const result = await fetchStatus(project.site)
			const state = stateOf(result)
			element.querySelector('.chip').replaceWith(chip(state))
			renderLive(body, project, result, state)
			return result
		}),
	)
	renderSummary(results)
}

main()
