import express from 'express';

import { apiRouter } from './api.js';
import type { Db } from './db/index.js';
import { errorHandler } from './lib/errors.js';
import type { MockProvider } from './providers/mock/mock-provider.js';
import { returnPage } from './providers/mock/pages.js';
import type { ProviderRegistry } from './providers/types.js';

export interface AppDeps {
  db: Db;
  providers: ProviderRegistry;
  mockProvider: MockProvider;
  jwtSecret: string;
  publicBaseUrl: string;
  logRequests?: boolean;
  devTools?: boolean;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  if (deps.logRequests) {
    app.use((req, res, next) => {
      const started = performance.now();
      res.on('finish', () => {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
      });
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/v1', apiRouter(deps));

  // The stand-in provider's hosted pages. In production these live on the
  // provider's own domain.
  app.use('/mock-provider', express.urlencoded({ extended: false }), deps.mockProvider.router());

  // Where the provider returns the customer. The app intercepts this URL and
  // closes its checkout view; a plain browser lands on this page instead.
  app.get('/checkout/return', (req, res) => {
    res.type('html').send(returnPage(req.query.canceled === '1'));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such route' } });
  });
  app.use(errorHandler);
  return app;
}
