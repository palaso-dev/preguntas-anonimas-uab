import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  CATEGORIES,
  LIVE_MODES,
  PROJECT_ROOT,
  STATUSES,
  clearAllConfessions,
  closeDb,
  createConfession,
  deleteConfession,
  getConfessionById,
  getSettings,
  hashPin,
  setFeaturedConfession,
  updateConfession,
  updateSettings,
  verifyPin,
} from './db.mjs';
import {
  checkSubmissionRateLimit,
  clearAdminCookie,
  createAdminCookie,
  createPresenterCookie,
  hasMatchingPresenterToken,
  isAdminRequest,
  isPresenterRequest,
  safeEqualStrings,
} from './auth.mjs';
import {
  broadcastState,
  buildAdminPayload,
  buildPresenterPayload,
  buildPublicPayload,
  closeAllSseClients,
  detectLanIpv4,
  registerSseClient,
  resolveEffectiveUrl,
} from './realtime.mjs';

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const MAX_JSON_BYTES = 16 * 1024;

const PAGE_ROUTES = new Map([
  ['/', 'index.html'],
  ['/admin', 'admin.html'],
  ['/presentadores', 'presentadores.html'],
  ['/live', 'live.html'],
  ['/qr', 'qr.html'],
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    ...extraHeaders,
  });
  res.end(text);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BYTES) {
        settled = true;
        const err = new Error('El mensaje es demasiado largo.');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('Se esperaba un objeto JSON válido.');
          err.statusCode = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error('El JSON enviado no tiene un formato válido.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

function isValidHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeCsvCell(value) {
  const str = String(value ?? '');
  const safeStr = /^[=+\-@]/.test(str) ? `'${str}` : str;
  if (/[",\r\n]/.test(safeStr)) {
    return `"${safeStr.replace(/"/g, '""')}"`;
  }
  return safeStr;
}

function confessionsToCsv(rows) {
  const header = ['id', 'fecha_utc', 'categoria', 'autor', 'estado', 'destacada', 'mensaje'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.created_at,
        row.category,
        row.author,
        row.status,
        row.is_featured ? 'si' : 'no',
        row.message,
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

async function servePublicFile(res, filePath, extraHeaders = {}) {
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      ...extraHeaders,
    });
    res.end(content);
  } catch {
    sendText(res, 404, 'Archivo no encontrado.');
  }
}

export async function startServer({ port = Number(process.env.PORT) || 3000, host = '0.0.0.0' } = {}) {
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const pathname = requestUrl.pathname;
      const settings = getSettings();

      if (method === 'GET' && PAGE_ROUTES.has(pathname)) {
        const htmlFile = path.join(PUBLIC_DIR, PAGE_ROUTES.get(pathname));
        const extraHeaders = {};
        if (pathname === '/presentadores' && hasMatchingPresenterToken(req, settings)) {
          extraHeaders['Set-Cookie'] = createPresenterCookie(req, settings);
        }
        await servePublicFile(res, htmlFile, extraHeaders);
        return;
      }

      if (
        method === 'GET' &&
        (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/img/'))
      ) {
        let decodedPath;
        try {
          decodedPath = decodeURIComponent(pathname);
        } catch {
          sendText(res, 400, 'Ruta inválida.');
          return;
        }
        const resolved = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
        if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
          sendText(res, 403, 'Acceso denegado.');
          return;
        }
        await servePublicFile(res, resolved);
        return;
      }

      if (method === 'GET' && (pathname === '/api/qr.svg' || pathname === '/api/qr.png')) {
        const paramUrl = requestUrl.searchParams.get('url');
        let qrTargetUrl = resolveEffectiveUrl(req, settings, boundPort).effectiveUrl;
        if (paramUrl && isAdminRequest(req, settings) && isValidHttpUrl(paramUrl)) {
          qrTargetUrl = paramUrl.trim();
        }
        const qrOptions = {
          errorCorrectionLevel: 'M',
          margin: 2,
          color: {
            dark: '#061326',
            light: '#ffffff',
          },
        };
        setSecurityHeaders(res);
        if (pathname === '/api/qr.svg') {
          const svg = await QRCode.toString(qrTargetUrl, { ...qrOptions, type: 'svg' });
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(svg);
          return;
        }
        const pngBuffer = await QRCode.toBuffer(qrTargetUrl, {
          ...qrOptions,
          type: 'png',
          width: 1024,
        });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        });
        res.end(pngBuffer);
        return;
      }

      if (method === 'GET' && pathname === '/api/events') {
        const channel = requestUrl.searchParams.get('channel') || 'live';
        if (channel === 'admin' && !isAdminRequest(req, settings)) {
          sendJson(res, 401, { error: 'Se requiere sesión de moderación.' });
          return;
        }
        if (channel === 'presenters' && !isPresenterRequest(req, settings)) {
          sendJson(res, 401, { error: 'Se requiere acceso de presentadores.' });
          return;
        }
        const normalizedChannel =
          channel === 'admin' || channel === 'presenters' ? channel : 'live';
        setSecurityHeaders(res);
        registerSseClient(req, res, normalizedChannel, boundPort);
        return;
      }

      if (method === 'GET' && pathname === '/api/public/state') {
        sendJson(res, 200, buildPublicPayload(req, boundPort));
        return;
      }

      if (method === 'POST' && pathname === '/api/confessions') {
        if (settings.submissions_open !== 'true') {
          sendJson(res, 403, { error: 'El buzón de confesiones está pausado en este momento.' });
          return;
        }
        const body = await readJsonBody(req);
        const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
        if (rawMessage.length < 5 || rawMessage.length > 320) {
          sendJson(res, 400, {
            error: 'La confesión debe tener entre 5 y 320 caracteres.',
          });
          return;
        }
        const rawAuthor = typeof body.author === 'string' ? body.author.trim() : '';
        if (rawAuthor.length > 40) {
          sendJson(res, 400, {
            error: 'El apodo o firma no puede superar los 40 caracteres.',
          });
          return;
        }
        const rawCategory =
          typeof body.category === 'string' && body.category.trim()
            ? body.category.trim()
            : 'Confesión';
        if (!CATEGORIES.includes(rawCategory)) {
          sendJson(res, 400, { error: 'Categoría no válida.' });
          return;
        }
        const rateCheck = checkSubmissionRateLimit(req);
        if (!rateCheck.allowed) {
          sendJson(
            res,
            429,
            { error: rateCheck.message },
            { 'Retry-After': String(rateCheck.retryAfterSeconds) },
          );
          return;
        }

        const created = createConfession({
          message: rawMessage,
          author: rawAuthor || 'Anónimo',
          category: rawCategory,
        });
        broadcastState();
        sendJson(res, 201, { confession: created });
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/login') {
        const body = await readJsonBody(req);
        const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
        if (!verifyPin(pin, settings.admin_pin_hash)) {
          sendJson(res, 401, { error: 'PIN incorrecto.' });
          return;
        }
        sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': createAdminCookie(req, settings) },
        );
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/logout') {
        sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': clearAdminCookie(req) },
        );
        return;
      }

      if (method === 'POST' && pathname === '/api/presenter/login') {
        const body = await readJsonBody(req);
        const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const validPin = pin ? verifyPin(pin, settings.admin_pin_hash) : false;
        const validToken = token ? safeEqualStrings(token, settings.presenter_token || '') : false;
        if (!validPin && !validToken) {
          sendJson(res, 401, { error: 'PIN o código de acceso inválido.' });
          return;
        }
        sendJson(
          res,
          200,
          { ok: true },
          { 'Set-Cookie': createPresenterCookie(req, settings) },
        );
        return;
      }

      if (method === 'GET' && pathname === '/api/presenter/state') {
        if (!isPresenterRequest(req, settings)) {
          sendJson(res, 401, { error: 'Acceso restringido a presentadores.' });
          return;
        }
        sendJson(res, 200, buildPresenterPayload(req, boundPort));
        return;
      }

      const presenterReadMatch = pathname.match(/^\/api\/presenter\/confessions\/(\d+)\/read$/);
      if (method === 'POST' && presenterReadMatch) {
        if (!isPresenterRequest(req, settings)) {
          sendJson(res, 401, { error: 'Acceso restringido a presentadores.' });
          return;
        }
        const id = Number(presenterReadMatch[1]);
        const existing = getConfessionById(id);
        if (!existing || (existing.status !== 'approved' && existing.status !== 'read')) {
          sendJson(res, 404, { error: 'Confesión no disponible para presentadores.' });
          return;
        }
        const body = await readJsonBody(req);
        const targetStatus =
          body.read === true
            ? 'read'
            : body.read === false
              ? 'approved'
              : existing.status === 'read'
                ? 'approved'
                : 'read';
        const updated = updateConfession(id, { status: targetStatus });
        if (targetStatus === 'read' && existing.is_featured) {
          setFeaturedConfession(null);
        }
        broadcastState();
        sendJson(res, 200, { confession: getConfessionById(updated.id) });
        return;
      }

      const presenterFeatureMatch = pathname.match(/^\/api\/presenter\/confessions\/(\d+)\/feature$/);
      if (method === 'POST' && presenterFeatureMatch) {
        if (!isPresenterRequest(req, settings)) {
          sendJson(res, 401, { error: 'Acceso restringido a presentadores.' });
          return;
        }
        const id = Number(presenterFeatureMatch[1]);
        const existing = getConfessionById(id);
        if (!existing || (existing.status !== 'approved' && existing.status !== 'read')) {
          sendJson(res, 404, { error: 'Confesión no disponible para proyectar.' });
          return;
        }
        const body = await readJsonBody(req);
        const shouldFeature =
          typeof body.feature === 'boolean' ? body.feature : !existing.is_featured;
        const featured = shouldFeature ? setFeaturedConfession(id) : setFeaturedConfession(null);
        broadcastState();
        sendJson(res, 200, { featured });
        return;
      }

      if (pathname.startsWith('/api/admin/')) {
        if (!isAdminRequest(req, settings)) {
          sendJson(res, 401, { error: 'Debes iniciar sesión como moderador.' });
          return;
        }

        if (method === 'GET' && pathname === '/api/admin/state') {
          sendJson(res, 200, buildAdminPayload(req, boundPort));
          return;
        }

        if (method === 'POST' && pathname.match(/^\/api\/admin\/confessions\/(\d+)\/approve-and-feature$/)) {
          const match = pathname.match(/^\/api\/admin\/confessions\/(\d+)\/approve-and-feature$/);
          const id = Number(match[1]);
          const existing = getConfessionById(id);
          if (!existing) {
            sendJson(res, 404, { error: 'Confesión no encontrada.' });
            return;
          }
          const featured = setFeaturedConfession(id);
          broadcastState();
          sendJson(res, 200, { confession: featured });
          return;
        }

        const adminConfessionMatch = pathname.match(/^\/api\/admin\/confessions\/(\d+)$/);
        if (method === 'PATCH' && adminConfessionMatch) {
          const id = Number(adminConfessionMatch[1]);
          const existing = getConfessionById(id);
          if (!existing) {
            sendJson(res, 404, { error: 'Confesión no encontrada.' });
            return;
          }
          const body = await readJsonBody(req);
          const patch = {};

          if (body.message !== undefined) {
            if (typeof body.message !== 'string') {
              sendJson(res, 400, { error: 'Mensaje inválido.' });
              return;
            }
            const trimmedMsg = body.message.trim();
            if (trimmedMsg.length < 5 || trimmedMsg.length > 320) {
              sendJson(res, 400, {
                error: 'La confesión debe tener entre 5 y 320 caracteres.',
              });
              return;
            }
            patch.message = trimmedMsg;
          }

          if (body.author !== undefined) {
            if (typeof body.author !== 'string') {
              sendJson(res, 400, { error: 'Autor inválido.' });
              return;
            }
            const trimmedAuthor = body.author.trim();
            if (trimmedAuthor.length > 40) {
              sendJson(res, 400, {
                error: 'El apodo o firma no puede superar los 40 caracteres.',
              });
              return;
            }
            patch.author = trimmedAuthor || 'Anónimo';
          }

          if (body.category !== undefined) {
            if (!CATEGORIES.includes(body.category)) {
              sendJson(res, 400, { error: 'Categoría no válida.' });
              return;
            }
            patch.category = body.category;
          }

          if (body.status !== undefined) {
            if (!STATUSES.includes(body.status)) {
              sendJson(res, 400, { error: 'Estado no válido.' });
              return;
            }
            patch.status = body.status;
          }

          let updated = updateConfession(id, patch);
          if (body.feature === true) {
            updated = setFeaturedConfession(id);
          } else if (body.feature === false && updated.is_featured) {
            setFeaturedConfession(null);
            updated = getConfessionById(id);
          }

          broadcastState();
          sendJson(res, 200, { confession: updated });
          return;
        }

        if (method === 'DELETE' && adminConfessionMatch) {
          const id = Number(adminConfessionMatch[1]);
          const deleted = deleteConfession(id);
          if (!deleted) {
            sendJson(res, 404, { error: 'Confesión no encontrada.' });
            return;
          }
          broadcastState();
          sendJson(res, 200, { ok: true });
          return;
        }

        if (method === 'DELETE' && pathname === '/api/admin/confessions') {
          const removedCount = clearAllConfessions();
          broadcastState();
          sendJson(res, 200, { ok: true, removedCount });
          return;
        }

        if (method === 'PATCH' && pathname === '/api/admin/settings') {
          const body = await readJsonBody(req);
          const nextSettings = {};

          if (body.event_title !== undefined) {
            const title = typeof body.event_title === 'string' ? body.event_title.trim() : '';
            if (title.length < 2 || title.length > 80) {
              sendJson(res, 400, { error: 'El título debe tener entre 2 y 80 caracteres.' });
              return;
            }
            nextSettings.event_title = title;
          }

          if (body.event_subtitle !== undefined) {
            const subtitle =
              typeof body.event_subtitle === 'string' ? body.event_subtitle.trim() : '';
            if (subtitle.length > 100) {
              sendJson(res, 400, { error: 'El subtítulo no debe superar los 100 caracteres.' });
              return;
            }
            nextSettings.event_subtitle = subtitle;
          }

          if (body.submissions_open !== undefined) {
            nextSettings.submissions_open = body.submissions_open ? 'true' : 'false';
          }

          if (body.live_mode !== undefined) {
            if (!LIVE_MODES.includes(body.live_mode)) {
              sendJson(res, 400, { error: 'Modo de pantalla en vivo inválido.' });
              return;
            }
            nextSettings.live_mode = body.live_mode;
          }

          if (body.public_url !== undefined) {
            const rawUrl = typeof body.public_url === 'string' ? body.public_url.trim() : '';
            if (rawUrl && !isValidHttpUrl(rawUrl)) {
              sendJson(res, 400, {
                error: 'La URL pública debe comenzar con http:// o https://.',
              });
              return;
            }
            nextSettings.public_url = rawUrl.replace(/\/+$/, '');
          }

          if (body.new_pin !== undefined && body.new_pin !== '') {
            const newPin = typeof body.new_pin === 'string' ? body.new_pin.trim() : '';
            if (newPin.length < 4 || newPin.length > 12) {
              sendJson(res, 400, { error: 'El nuevo PIN debe tener entre 4 y 12 caracteres.' });
              return;
            }
            nextSettings.admin_pin_hash = hashPin(newPin);
          }

          const updated = updateSettings(nextSettings);
          broadcastState();
          sendJson(res, 200, { settings: updated });
          return;
        }

        if (method === 'GET' && pathname === '/api/admin/export') {
          const format = (requestUrl.searchParams.get('format') || 'csv').toLowerCase();
          const allConfessions = buildAdminPayload(req, boundPort).confessions;
          setSecurityHeaders(res);
          if (format === 'json') {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': 'attachment; filename="confesiones-gala.json"',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(allConfessions, null, 2));
            return;
          }
          const csv = confessionsToCsv(allConfessions);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="confesiones-gala.csv"',
            'Cache-Control': 'no-store',
          });
          res.end(csv);
          return;
        }
      }

      sendJson(res, 404, { error: 'Ruta no encontrada.' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      const message =
        status >= 500 ? 'Error interno del servidor.' : error.message || 'Solicitud inválida.';
      if (!res.headersSent) {
        sendJson(res, status, { error: message });
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') {
        boundPort = address.port;
      }
      resolve();
    });
  });

  async function stopServer() {
    closeAllSseClients();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    closeDb();
  }

  return {
    server,
    port: boundPort,
    host,
    lanIp: detectLanIpv4(),
    stopServer,
  };
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const port = Number(process.env.PORT) || 3000;
  const started = await startServer({ port, host: '0.0.0.0' });
  const localUrl = `http://localhost:${started.port}`;
  const lanUrl = `http://${started.lanIp}:${started.port}`;
  const settings = getSettings();

  console.log('');
  console.log('Cena de Gala Navideña — Servidor local activo');
  console.log(`Invitados (Wi-Fi local): ${lanUrl}`);
  console.log(`Moderación (/admin):     ${localUrl}/admin`);
  console.log(`Presentadores:           ${localUrl}/presentadores?k=${settings.presenter_token}`);
  console.log(`Pantalla en vivo:        ${localUrl}/live`);
  console.log(`Tarjeta QR imprimible:   ${localUrl}/qr`);
  console.log('');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await started.stopServer();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
