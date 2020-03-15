const rateLimit = require('express-rate-limit');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');
const { manifest } = require('./lib/manifest');
const parseConfiguration = require('./lib/configuration');
const landingTemplate = require('./lib/landingTemplate');
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
  console.log(configValues);
  const landingHTML = landingTemplate(manifest(), configValues.providers, configValues.realdebrid);
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
});

router.get('/:configuration/manifest.json', (req, res) => {
  const configValues = parseConfiguration(req.params.configuration);
  const manifestBuf = JSON.stringify(manifest(configValues.providers, configValues.realdebrid));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(manifestBuf)
});

module.exports = function (req, res) {
  router(req, res, function () {
    res.statusCode = 404;
    res.end();
  });
};
