const rateLimit = require('express-rate-limit');
const { getRouter } = require('stremio-addon-sdk');
const requestIp = require('request-ip');
const addonInterface = require('./addon');
const qs = require('querystring')
const { manifest } = require('./lib/manifest');
const parseConfiguration = require('./lib/configuration');
const landingTemplate = require('./lib/landingTemplate');
const moch = require('./moch/moch');

const router = getRouter({ ...addonInterface, manifest: manifest() });
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hours
  max: 300, // limit each IP to 300 requests per windowMs
  headers: false
});

router.use(limiter);

router.get('/', (_, res) => {
  res.redirect('/configure')
  res.end();
});

router.get('/:configuration?/configure', (req, res) => {
  const configValues = parseConfiguration(req.params.configuration || '');
  const landingHTML = landingTemplate(manifest(configValues), configValues);
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
});

router.get('/:configuration?/manifest.json', (req, res) => {
  const configValues = parseConfiguration(req.params.configuration || '');
  const manifestBuf = JSON.stringify(manifest(configValues));
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

router.get('/:moch/:apiKey/:infoHash/:cachedEntryInfo/:fileIndex?', (req, res) => {
  const parameters = {
    mochKey: req.params.moch,
    apiKey: req.params.apiKey,
    infoHash: req.params.infoHash,
    fileIndex: isNaN(req.params.fileIndex) ? undefined : parseInt(req.params.fileIndex),
    cachedEntryInfo: req.params.cachedEntryInfo,
    ip: requestIp.getClientIp(req)
  }
  moch.resolve(parameters)
      .then(url => {
        res.writeHead(302, { Location: url });
        res.end();
      })
      .catch(error => {
        console.log(error);
        res.statusCode = 404;
        res.end();
      });
});

module.exports = function (req, res) {
  router(req, res, function () {
    res.statusCode = 404;
    res.end();
  });
};
