# Live test results dashboard

The front door for my test automation projects: <https://yeshallbeasgods.github.io/>.

Each project runs its tests in CI on every push and nightly, then publishes a small `status.json` next to its report on
its own GitHub Pages site. This page fetches those files in the visitor's browser and shows what it finds. It is plain
HTML, CSS and JavaScript: no build step, no dependencies, no server and no stored data.

## Files

| File            | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `index.html`    | The page structure. Dark theme by default, with a light-mode toggle.  |
| `style.css`     | The whole look. Colors, fonts and shapes are CSS variables.           |
| `app.js`        | Loads `projects.json`, fetches each `status.json`, renders the tiles. |
| `projects.json` | The list of projects. This is the only file to edit to add one.       |
| `.nojekyll`     | Tells GitHub Pages to serve the files as they are.                    |

## The status contract (schema 1)

Every live project publishes `status.json` at the root of its Pages site. Example:
<https://yeshallbeasgods.github.io/universal-cloudless-thousandoaks/status.json>.

```json
{
	"schema": 1,
	"project": "<repo name>",
	"overall": "passed",
	"generatedAt": "2026-10-17T21:50:42.673Z",
	"trigger": "push",
	"branch": "main",
	"commit": { "sha": "<40 hex>", "short": "<7 chars>", "url": "https://github.com/.../commit/<sha>" },
	"run": { "id": "...", "url": "https://github.com/.../actions/runs/<id>" },
	"layers": { "lint": "success", "smoke": "success" },
	"tests": { "total": 6, "passed": 6, "failed": 0, "broken": 0, "skipped": 0, "flaky": 0 },
	"links": { "report": "report/", "trends": "report/dashboard/", "testHealth": null }
}
```

- `overall` is `passed` only if every value in `layers` is `success`. Layer names differ per project.
- Each test is counted once, by its last attempt. A test that failed and then passed on retry counts as passed and flaky.
- Expected failures (`xfail`) count as passed.
- `links.report` and `links.trends` are paths relative to the project's own Pages root. `trends` is optional.
- The page only follows a relative link if it stays inside that project's site, and only accepts `github.com` URLs for
  the commit and the CI run.

## What the page does with it

- A result older than 36 hours is shown as **stale**. Nightly runs should land daily, so a quietly broken schedule
  cannot look healthy. The limit is `STALE_AFTER_HOURS` at the top of `app.js`.
- A file that cannot be fetched, or does not match the contract, shows the tile as **unavailable** instead of failing.
- Projects with no `site` in `projects.json` are shown as **asleep**: built, but not yet publishing live results.
- Values from remote files are inserted as text, never as HTML.

## Adding a project

1. Make the repo publish a `status.json` to its Pages site, following the contract above.
2. Add an entry to `projects.json` with the repo URL and its `site` URL. Without `site`, the tile stays asleep.

## Previewing locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. The page reads the live `status.json` files, which allow cross-site reads.

## Changing the look

Everything visual comes from the variables at the top of `style.css`. A new look (a different palette, fonts or shapes)
is a different set of values, so the markup and the script do not need to change.
