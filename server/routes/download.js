// GET /api/download/urls — returns current installer download URLs.
// Update DOWNLOAD_URL_WINDOWS / DOWNLOAD_URL_MAC env vars when publishing a new build.

const router = require('express').Router();

router.get('/urls', (_req, res) => {
  res.json({
    windows: process.env.DOWNLOAD_URL_WINDOWS || '',
    mac:     process.env.DOWNLOAD_URL_MAC     || '',
    version: process.env.DOWNLOAD_VERSION     || '',
  });
});

module.exports = router;
