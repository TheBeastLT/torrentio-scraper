const rateLimit = require('express-rate-limit');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const { manifest } = require('./lib/manifest');
const parseConfiguration = require('./lib/configuration');
const landingTemplate = require('./lib/landingTemplate');
const realDebrid = require('./moch/realdebrid');

const router = getRouter(addonInterface);
const limiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 10, // limit each IP to 10 requests per windowMs
  headers: false
});

router.use(limiter);

router.get('/', (_, res) => {
  const landingHTML = landingTemplate(manifest());
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
});

router.get('/:configuration', (req, res) => {
  const configValues = parseConfiguration(req.params.configuration);
  const landingHTML = landingTemplate(manifest(configValues), configValues);
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
});

router.get('/:configuration/manifest.json', (req, res) => {
  const configValues = parseConfiguration(req.params.configuration);
  const manifestBuf = JSON.stringify(manifest(configValues));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(manifestBuf)
});

router.get('/:configuration/:resource/:type/:id.json', (req, res, next) => {
  const { configuration, resource, type, id } = req.params;
  const configValues = parseConfiguration(configuration);
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

router.get('/realdebrid/:apiKey/:infoHash/:cachedFileIds/:fileIndex?', (req, res) => {
  const { apiKey, infoHash, cachedFileIds, fileIndex } = req.params;
  realDebrid.resolve(apiKey, infoHash, cachedFileIds, isNaN(fileIndex) ? undefined : parseInt(fileIndex))
      .then(url => {
        res.writeHead(301, { Location: url });
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
