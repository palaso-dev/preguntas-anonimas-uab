import os from 'node:os';
import {
  getAdminSafeSettings,
  getCounts,
  getFeaturedConfession,
  getPublicSettings,
  listConfessions,
  listPresenterConfessions,
  listPublicApproved,
} from './db.mjs';

const clients = new Set();

export function detectLanIpv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (entry && entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

export function resolveEffectiveUrl(req, settings, serverPort = 3000) {
  const lanIp = detectLanIpv4();
  const lanUrl = `http://${lanIp}:${serverPort}`;
  if (settings.public_url) {
    return { effectiveUrl: settings.public_url, lanUrl };
  }
  if (req) {
    const hostHeader = String(req.headers.host || '').trim();
    if (hostHeader) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
      const proto = forwardedProto === 'https' || req.socket?.encrypted ? 'https' : 'http';
      const isLoopbackHost =
        hostHeader.startsWith('localhost') ||
        hostHeader.startsWith('127.0.0.1') ||
        hostHeader.startsWith('[::1]');
      if (!isLoopbackHost) {
        return { effectiveUrl: `${proto}://${hostHeader}`, lanUrl };
      }
    }
  }
  return { effectiveUrl: lanUrl, lanUrl };
}

export function buildPublicPayload(req, serverPort = 3000) {
  const publicSettings = getPublicSettings();
  const counts = getCounts();
  const featured = getFeaturedConfession();
  const wallItems = listPublicApproved(8);
  const { effectiveUrl, lanUrl } = resolveEffectiveUrl(req, publicSettings, serverPort);
  const approvedCount = counts.approved + counts.read;
  return {
    publicSettings,
    settings: publicSettings,
    effectiveUrl,
    lanUrl,
    featured,
    wallItems,
    wall: wallItems,
    totalReceived: counts.total,
    approvedCount,
    counts: {
      total: counts.total,
      approved: approvedCount,
    },
  };
}

export function buildPresenterPayload(req, serverPort = 3000) {
  const publicSettings = getPublicSettings();
  const counts = getCounts();
  const featured = getFeaturedConfession();
  const approvedAndRead = listPresenterConfessions();
  const { effectiveUrl, lanUrl } = resolveEffectiveUrl(req, publicSettings, serverPort);
  return {
    publicSettings,
    settings: publicSettings,
    effectiveUrl,
    lanUrl,
    featured,
    approvedAndRead,
    confessions: approvedAndRead,
    counts,
  };
}

export function buildAdminPayload(req, serverPort = 3000) {
  const settings = getAdminSafeSettings();
  const counts = getCounts();
  const featured = getFeaturedConfession();
  const confessions = listConfessions();
  const { effectiveUrl, lanUrl } = resolveEffectiveUrl(req, settings, serverPort);
  return {
    settings,
    effectiveUrl,
    lanUrl,
    featured,
    confessions,
    counts,
  };
}

function buildPayloadForChannel(channel, req, serverPort) {
  if (channel === 'admin') {
    return buildAdminPayload(req, serverPort);
  }
  if (channel === 'presenters') {
    return buildPresenterPayload(req, serverPort);
  }
  return buildPublicPayload(req, serverPort);
}

function writeSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

const heartbeatTimer = setInterval(() => {
  for (const client of clients) {
    try {
      client.res.write(': ping\n\n');
    } catch {
      clients.delete(client);
    }
  }
}, 20000);

heartbeatTimer.unref();

export function registerSseClient(req, res, channel, serverPort = 3000) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = { req, res, channel, serverPort };
  clients.add(client);

  const initialPayload = buildPayloadForChannel(channel, req, serverPort);
  writeSseEvent(res, 'state', initialPayload);

  req.on('close', () => {
    clients.delete(client);
  });
}

export function broadcastState() {
  if (clients.size === 0) {
    return;
  }

  const cachedPayloads = new Map();
  for (const client of clients) {
    const cacheKey = `${client.channel}:${client.serverPort}:${client.req.headers.host || ''}`;
    let payload = cachedPayloads.get(cacheKey);
    if (!payload) {
      payload = buildPayloadForChannel(client.channel, client.req, client.serverPort);
      cachedPayloads.set(cacheKey, payload);
    }
    try {
      writeSseEvent(client.res, 'state', payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function closeAllSseClients() {
  for (const client of clients) {
    try {
      client.res.end();
    } catch {
    }
  }
  clients.clear();
}
