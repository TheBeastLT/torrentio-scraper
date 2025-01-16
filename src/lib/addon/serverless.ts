import Router from 'router';
import cors from 'cors';
import rateLimit from "express-rate-limit";
import requestIp from 'request-ip';
import userAgentParser from 'ua-parser-js';
import addonInterface from '@/addon';
import qs from 'querystring';
import { manifest } from '@/lib/manifest';
import { parseConfiguration, PreConfigurations } from '@/lib/configuration';
import landingTemplate from '@/lib/landingTemplate';
import * as moch from '@/moch/moch';
import { NextFunction, Request, Response } from 'express';

const router = new Router();
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 300, // limit each IP to 300 requests per windowMs
  headers: false,
  keyGenerator: (req) => requestIp.getClientIp(req)
})

router.use(cors())
router.get('/', (_, res) => {
  res.redirect('/configure')
  res.end();
});

router.get(`/:preconfiguration(${Object.keys(PreConfigurations).join('|')})`, (req: Request, res: Response) => {
  res.redirect(`/${req.params.preconfiguration}/configure`)
  res.end();
});

router.get('/:configuration?/configure', (req: Request, res: Response) => {
  const configValues = parseConfiguration(req.params.configuration || '');
  const landingHTML = landingTemplate(manifest(configValues), configValues);
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
});

router.get('/:configuration?/manifeston', (req: Request, res: Response) => {
  const configValues = parseConfiguration(req.params.configuration || '');
  const manifestBuf = JSON.stringify(manifest(configValues));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(manifestBuf)
});

router.get('/:configuration?/:resource/:type/:id/:extra?on', limiter, (req: Request, res: Response, next: NextFunction) => {
  const { configuration, resource, type, id } = req.params;
  const extra = req.params.extra ? qs.parse(req.url.split('/').pop().slice(0, -5)) : {}
  const ip = requestIp.getClientIp(req);
  const host = `${req.protocol}://${req.headers.host}`;
  const configValues = { ...extra, ...parseConfiguration(configuration), id, type, ip, host };
  addonInterface.get(resource, type, id, configValues)
    .then(resp => {
      const cacheHeaders = {
        cacheMaxAge: 'max-age',
        staleRevalidate: 'stale-while-revalidate',
        staleError: 'stale-if-error'
      };
      const cacheControl = Object.keys(cacheHeaders)
        .map(prop => Number.isInteger(resp[prop]) && cacheHeaders[prop] + '=' + resp[prop])
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

router.get('/:moch/:apiKey/:infoHash/:cachedEntryInfo/:fileIndex/:filename?', (req: Request, res: Response) => {
  const userAgent = req.headers['user-agent'] || '';
  const parameters = {
    mochKey: req.params.moch,
    apiKey: req.params.apiKey,
    infoHash: req.params.infoHash.toLowerCase(),
    fileIndex: isNaN(req.params.fileIndex) ? undefined : parseInt(req.params.fileIndex),
    cachedEntryInfo: req.params.cachedEntryInfo,
    ip: requestIp.getClientIp(req),
    host: `${req.protocol}://${req.headers.host}`,
    isBrowser: !userAgent.includes('Stremio') && !!userAgentParser(userAgent).browser.name
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

export default function (req: Request, res: Response) {
  router(req, res, function () {
    res.statusCode = 404;
    res.end();
  });
};
