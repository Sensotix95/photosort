# SortMyPics — Claude Instructions

## About this project

SortMyPics is an AI photo organizer sold at €9.99 one-time. It runs in the browser (Chrome/Edge)
using the File System Access API so photos never leave the user's device. The owner is Patrick
(GitHub: Sensotix95). The web app is hosted on Railway at sortmypics.com. There is also a
downloadable Electron desktop app that wraps the exact same code.

---

## Desktop App Release Process

The project ships an Electron desktop app alongside the web version. GitHub Actions
automatically builds the Windows (.exe) and Mac (.dmg) installers whenever a version tag is pushed.
Releases publish directly (not as drafts) — no manual steps on GitHub needed.

### When to offer a release

At the end of any session where you made **functional changes** — new features, bug fixes,
improvements to the sorting algorithm, planBuilder, UI screens, or the Electron wrapper — ask:

> "Want me to release a new version of the desktop app? I'll bump the version number, update
> the download page, and push a tag — GitHub Actions builds everything automatically (~10 min)."

**Skip the offer** if the session only touched: blog posts, SEO meta tags, marketing copy,
CSS polish, or the /patrick dev page — changes that don't affect the desktop app's behaviour.

### How to do the release — do ALL of this when Patrick says yes

**Step 1 — Decide the version bump**

```bash
node -e "console.log(require('./package.json').version)"
```

- Bug fixes / small improvements → bump **patch** (1.0.0 → 1.0.1)
- New user-facing features → bump **minor** (1.0.0 → 1.1.0)
- Breaking changes → bump **major** (1.0.0 → 2.0.0)

**Step 2 — Update two files**

1. `package.json` — change the `version` field to the new version.

2. `public/download/index.html` — update the `DOWNLOADS` constant near the top of the script
   (just swap the version number in all three lines):
   ```js
   const DOWNLOADS = {
     windows: 'https://github.com/Sensotix95/photosort/releases/download/v{version}/SortMyPics-Setup-{version}.exe',
     mac:     'https://github.com/Sensotix95/photosort/releases/download/v{version}/SortMyPics-{version}.dmg',
     version: '{version}',
   };
   ```

**Step 3 — Commit, tag, push**

```bash
git add package.json public/download/index.html
git commit -m "Release v{version}"
git tag v{version}
git push && git push --tags
```

**Step 4 — Tell Patrick what happens next**

> "Done. GitHub Actions is building the Windows and Mac installers now — takes about 10 minutes.
> Watch progress at: https://github.com/Sensotix95/photosort/actions
>
> Once complete the release appears at: https://github.com/Sensotix95/photosort/releases
> The download page already has the correct URLs baked in — nothing else to do."

### Setup notes (already done — no action needed)

- Workflow uses `GITHUB_TOKEN` (auto-provided by GitHub Actions, no PAT or secrets needed)
- Repository workflow permissions must be set to **"Read and write"** — already configured at
  github.com/Sensotix95/photosort/settings/actions
- `"releaseType": "release"` in package.json publish config means releases publish directly,
  never as drafts — no manual "Publish release" click needed on GitHub

---

## Architecture Quick Reference

| Concern | Detail |
|---|---|
| Web server | Express on `server/index.js`, port from env (default 3000) |
| Electron wrapper | `electron/main.js` starts Express on port 3847, opens BrowserWindow |
| Electron settings | User's Gemini API key stored in OS user-data dir (`settings.json`) |
| Desktop mode | `DESKTOP_MODE=true` env var disables payment gate and Stripe routes |
| Gemini key (desktop) | User provides own key; sent as `X-Gemini-Key` request header |
| Gemini key (web) | Server uses `GEMINI_API_KEY` env var |
| Fallback (no key) | `localFallbackPlan()` in planBuilder.js uses geocoded location + date |
| Payment | Stripe; one €9.99 purchase covers both online and desktop download |
| Download URLs | Hardcoded in `DOWNLOADS` const in `public/download/index.html`; updated on each release |
| Installers | Built by `electron-builder`; Windows NSIS, Mac DMG |
| Releases | Published to github.com/Sensotix95/photosort/releases |
