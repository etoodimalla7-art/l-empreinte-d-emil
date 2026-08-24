const path = require('path');
const express = require('express');

const newProductHandler = require('./api/notifications/new-product');
const scheduledHandler = require('./api/notifications/scheduled');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const ROOT = __dirname;

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'lempreinte-emil' }));
app.post('/api/notifications/new-product', newProductHandler);
app.all('/api/notifications/scheduled', scheduledHandler);

// index.html and every public asset in the project are served by this same Render Web Service.
app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'] }));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route API introuvable.' });
  return next();
});

app.use((error, _req, res, _next) => {
  console.error('[server]', error);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

app.listen(PORT, HOST, () => {
  console.log(`L’Empreinte d’Emil listening on ${HOST}:${PORT}`);
});

module.exports = app;
