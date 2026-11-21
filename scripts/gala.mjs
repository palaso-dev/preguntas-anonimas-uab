import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, getSettings, setSetting } from '../src/db.mjs';
import { broadcastState } from '../src/realtime.mjs';
import { startServer } from '../src/server.mjs';

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_TIMEOUT_MS = 15000;

function resolveCloudflaredBin() {
  const localBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'cloudflared');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'cloudflared';
}

function startCaffeinate() {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
    });
    child.on('error', () => {});
    return child;
  } catch {
    return null;
  }
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  const started = await startServer({ port, host: '0.0.0.0' });
  const actualPort = started.port;
  const lanUrl = `http://${started.lanIp}:${actualPort}`;
  const localUrl = `http://localhost:${actualPort}`;

  const initialSettings = getSettings();
  if (/\.trycloudflare\.com/i.test(initialSettings.public_url || '')) {
    setSetting('public_url', '');
    broadcastState();
  }

  const caffeinateProc = startCaffeinate();
  const cloudflaredBin = resolveCloudflaredBin();

  let tunnelProc = null;
  let tunnelResolved = false;
  let shuttingDown = false;

  console.log('');
  console.log('Iniciando Cena de Gala Navideña...');
  console.log(`Servidor local listo en ${localUrl}`);
  if (caffeinateProc) {
    console.log('Modo anti-reposo activado en macOS (caffeinate).');
  }
  console.log('Abriendo túnel público seguro con Cloudflare...');

  const timeoutTimer = setTimeout(() => {
    if (!tunnelResolved && !shuttingDown) {
      console.log('');
      console.log('El túnel público tardó más de 15s en responder.');
      console.log(`El servidor sigue activo en red local (Wi-Fi): ${lanUrl}`);
      console.log(`Moderación (/admin):     ${localUrl}/admin`);
      console.log(`Pantalla en vivo:        ${localUrl}/live`);
      console.log(`Tarjeta QR imprimible:   ${localUrl}/qr`);
      console.log('');
    }
  }, TUNNEL_TIMEOUT_MS);
  timeoutTimer.unref();

  try {
    tunnelProc = spawn(
      cloudflaredBin,
      ['tunnel', '--url', `http://127.0.0.1:${actualPort}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    clearTimeout(timeoutTimer);
    console.log('');
    console.log('No se pudo iniciar cloudflared.');
    console.log(`Usando modo Wi-Fi local: ${lanUrl}`);
    console.log(`Moderación (/admin):     ${localUrl}/admin`);
    console.log(`Pantalla en vivo:        ${localUrl}/live`);
    console.log(`Tarjeta QR imprimible:   ${localUrl}/qr`);
    console.log('');
  }

  const handleTunnelOutput = (chunk) => {
    const text = chunk.toString('utf8');
    const match = text.match(TUNNEL_URL_REGEX);
    if (match && !tunnelResolved) {
      tunnelResolved = true;
      clearTimeout(timeoutTimer);
      const tunnelUrl = match[0].replace(/\/+$/, '');
      setSetting('public_url', tunnelUrl);
      broadcastState();
      const latestSettings = getSettings();

      console.log('');
      console.log('==============================================================');
      console.log('  CENA DE GALA NAVIDEÑA — EN VIVO');
      console.log('==============================================================');
      console.log(`  URL pública para invitados (QR):       ${tunnelUrl}`);
      console.log(`  Panel de moderación (en esta Mac):     ${localUrl}/admin`);
      console.log('  PIN inicial (si no se cambió):         2026');
      console.log(
        `  Link mágico para presentadores:        ${tunnelUrl}/presentadores?k=${latestSettings.presenter_token}`,
      );
      console.log(`  Pantalla gigante / proyector:          ${localUrl}/live`);
      console.log(`  Tarjeta QR imprimible:                 ${localUrl}/qr`);
      console.log('==============================================================');
      console.log('  Presiona Ctrl + C al finalizar la gala para cerrar todo.');
      console.log('');
    }
  };

  if (tunnelProc) {
    tunnelProc.stdout.on('data', handleTunnelOutput);
    tunnelProc.stderr.on('data', handleTunnelOutput);

    tunnelProc.on('error', () => {
      clearTimeout(timeoutTimer);
      if (!tunnelResolved && !shuttingDown) {
        console.log('');
        console.log('No se pudo ejecutar cloudflared. Manteniendo modo Wi-Fi local:');
        console.log(`Invitados (Wi-Fi): ${lanUrl}`);
        console.log(`Moderación:        ${localUrl}/admin`);
        console.log('');
      }
    });

    tunnelProc.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      if (!shuttingDown && !tunnelResolved) {
        console.log(`cloudflared finalizó (código ${code ?? 0}). Modo local activo en ${lanUrl}`);
      }
    });
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearTimeout(timeoutTimer);
    console.log('\nCerrando túnel y servidor de la Cena de Gala...');
    if (tunnelProc && !tunnelProc.killed) {
      tunnelProc.kill('SIGTERM');
    }
    if (caffeinateProc && !caffeinateProc.killed) {
      caffeinateProc.kill('SIGTERM');
    }
    await started.stopServer();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Error al iniciar la gala:', error);
  process.exit(1);
});
