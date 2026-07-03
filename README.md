# chilos.dev — repo index site

Static replacement for chilos.dev: an index of every repo on
[github.com/chouithegewy](https://github.com/chouithegewy) with links, contact
links (GitHub, email, Facebook, Instagram), and a page for the tydle mp3 deck
project.

- `site/` — the deployable site (two pages + CSS + screenshot; no build step,
  no server-side code)
- `repos.json` — snapshot of the GitHub repo data baked into `site/index.html`
- `deploy.sh` — rsync to the server (edit host/docroot first)

## Refreshing the repo list

The repo list is baked into `index.html` as a JSON `<script>` block. To
refresh it:

```sh
gh api users/chouithegewy/repos --paginate \
  --jq '[.[] | {name, description, language, fork, updated_at, html_url, stargazers_count}]' > repos.json
```

then replace the contents of `<script id="repo-data">` in `site/index.html`
with the new JSON (escape `<` as `<` if any description contains it).

## Preview locally

```sh
python3 -m http.server -d site 8000
```
