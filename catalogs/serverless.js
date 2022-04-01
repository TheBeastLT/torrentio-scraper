const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const qs = require('querystring')
const { parseConfiguration } = require('../addon/lib/configuration');
const { createManifest } = require('./lib/manifest');

const router = getRouter(addonInterface);

// router.get('/', (_, res) => {
//   res.redirect('/configure')
//   res.end();
// });
//
// router.get('/:configuration?/configure', (req, res) => {
//   const configValues = parseConfiguration(req.params.configuration || '');
//   const landingHTML = landingTemplate(createManifest(configValues), configValues);
//   res.setHeader('content-type', 'text/html');
//   res.end(landingHTML);
// });

router.get('/:configuration?/manifest.json', (req, res) => {
  const configValues = parseConfiguration(req.params.configuration || '');
  const manifestBuf = JSON.stringify(createManifest(configValues));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(manifestBuf)
});

router.get('/:configuration/:resource/:type/:id/:extra?.json', (req, res, next) => {
  const { configuration, resource, type, id } = req.params;
  const extra = req.params.extra ? qs.parse(req.url.split('/').pop().slice(0, -5)) : {}
  const configValues = { ...extra, ...parseConfiguration(configuration) };
  addonInterface.get(resource, type, id, configValues)
      .then(resp => {
        const cacheHeaders = {
          cacheMaxAge: 'max-age',
          staleRevalidate: 'stale-while-revalidate',
          staleError: 'stale-if-error'
        };
        const cacheControl = Object.keys(cacheHeaders)
            .map(prop => resp[prop] && cacheHeaders[prop] + '=' + resp[prop])
            .filter(val => !!val).join(', ');

        res.setHeader('Cache-Control', `${cacheControl}, public`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(resp));
      })
      .catch(err => {
        if (err.noHandler) {
          if (next) {
            next()
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ err: 'not found' }));
          }
        } else {
          console.error(err);
          res.writeHead(500);
          res.end(JSON.stringify({ err: 'handler error' }));
        }
      });
});

module.exports = function (req, res) {
  router(req, res, function () {
    res.statusCode = 404;
    res.end();
  });
};
