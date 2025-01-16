import { getRouter } from 'stremio-addon-sdk';
import addonInterface from './addon';
import qs from 'querystring';
import { parseConfiguration } from '../addon/lib/configuration';
import { createManifest } from './lib/manifest';
import { NextFunction, Request, Response } from 'express';

const router = getRouter(addonInterface);

router.get('/:configuration?/manifest.json', (req: Request, res: Response) => {
  const configValues = parseConfiguration(req.params.configuration || '');
  const manifestBuf = JSON.stringify(createManifest(configValues));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(manifestBuf)
});

router.get('/:configuration/:resource/:type/:id/:extra?.json', (req: Request, res: Response, next: NextFunction) => {
  const { configuration, resource, type, id } = req.params;

  const reqUrl = req.url;

  if (!reqUrl) {
    throw new Error('No request URL found.');
  }

  const reqUrls = reqUrl.split('/');

  if (reqUrls.length === 0) {
    throw new Error('No request URL found.')
  }

  const popedUrls = reqUrls.pop();

  if (!popedUrls) {
    throw new Error('No request URL found.');
  }

  const extra = req.params.extra ? qs.parse(popedUrls.slice(0, -5)) : {};

  const configValues = { ...extra, ...parseConfiguration(configuration) };

  addonInterface.get(resource, type, id, configValues)
    .then(resp => {
      const cacheHeaders = {
        cacheMaxAge: 'max-age',
        staleRevalidate: 'stale-while-revalidate',
        staleError: 'stale-if-error'
      };

      const cacheControl = Object.keys(cacheHeaders)
        .map((prop) => Number.isInteger(resp[prop]) && cacheHeaders[prop] + '=' + resp[prop])
        .filter((val) => Boolean(val)).join(', ');

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

/**
 * Express route handler for the serverless catalog addon.
 *
 * @param {Request} req Express request object
 * @param {Response} res Express response object
 */
export default function run(req: Request, res: Response) {
  router(req, res, () => {
    res.statusCode = 404;
    res.end();
  });
};
