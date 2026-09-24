# chilos.dev

Source for David Childs's home page: a minimal static page, with no JavaScript, about
the vr_fire capstone project. It's published in two places:

- **https://chilos.dev/**: the VPS, deployed with `deploy.sh`
- **https://chouithegewy.github.io/**: published automatically by a GitHub Action on
  every push or merge to `main`

## Layout

- `site/`: the deployable site (`index.html`, plus `tydle.html` and its assets)
- `deploy.sh`: rsyncs `site/` to the server. It never deletes the separately
  deployed `vr_fire/` and `ssbm/` apps.
- `.github/workflows/publish-github-pages.yml`: copies `site/` into the
  `chouithegewy.github.io` repo, leaving its `frogger3d/` folder alone
- `repos.json`, `mp3-frontend/`: from the earlier repo-index version of the site

## Publishing

**GitHub Pages** happens on its own: push to `main` and the workflow updates
`chouithegewy.github.io`. You can also run it from the Actions tab
(**Publish to GitHub Pages → Run workflow**).

It authenticates with the `PAGES_DEPLOY_KEY` secret: the private half of a deploy key
with write access to the `chouithegewy.github.io` repo only. To rotate it:

```sh
ssh-keygen -t ed25519 -N "" -f key
gh repo deploy-key add key.pub --repo chouithegewy/chouithegewy.github.io --allow-write --title "chilos.dev site publish"
gh secret set PAGES_DEPLOY_KEY --repo chouithegewy/chilos.dev < key
rm key key.pub
```

Then delete the old key under the Pages repo's **Settings → Deploy keys**.

**chilos.dev** (the VPS):

```sh
./deploy.sh thehomiedavid@chilos.dev /var/www/chilos.dev
```

## Preview locally

```sh
python3 -m http.server -d site 8000
```
