#!/usr/bin/env node
// ============================================================
// DealsHub — Backup & Versioning System
// ============================================================
// Usage:
//   node scripts/backup.js                    → Full backup (theme + backend snapshot)
//   node scripts/backup.js --theme-only       → Solo theme de Shopify
//   node scripts/backup.js --list             → Listar backups existentes
//   node scripts/backup.js --rollback <tag>   → Restaurar un backup al theme live
//   node scripts/backup.js --diff <tag>       → Ver diferencias vs backup
//   node scripts/backup.js --tag "descripción" → Agregar etiqueta descriptiva
// ============================================================

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---- CONFIG ----
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN || '1rnmax-5z.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const THEME_ID = process.env.SHOPIFY_THEME_ID || '157178462339';
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const CHANGELOG_FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const VERSION_FILE = path.join(__dirname, '..', 'VERSION.json');

// ---- HELPERS ----
function shopifyAPI(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SHOPIFY_STORE,
      path: `/admin/api/2024-01${apiPath}`,
      method,
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function getVersionInfo() {
  if (fs.existsSync(VERSION_FILE)) {
    return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  }
  return { version: '1.0.0', lastBackup: null, backups: [] };
}

function saveVersionInfo(info) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(info, null, 2));
}

function bumpVersion(info, type = 'patch') {
  const [major, minor, patch] = info.version.split('.').map(Number);
  if (type === 'major') info.version = `${major + 1}.0.0`;
  else if (type === 'minor') info.version = `${major}.${minor + 1}.0`;
  else info.version = `${major}.${minor}.${patch + 1}`;
  return info.version;
}

// ---- BACKUP: Download all theme assets from Shopify ----
async function backupTheme(tag = '') {
  console.log('📦 Descargando assets del theme live de Shopify...');

  // Get asset list
  const listResp = await shopifyAPI('GET', `/themes/${THEME_ID}/assets.json`);
  if (!listResp || !listResp.assets) {
    console.error('❌ No se pudieron obtener los assets del theme');
    console.error('   Verifica SHOPIFY_ADMIN_TOKEN y SHOPIFY_THEME_ID');
    return null;
  }

  const assets = listResp.assets;
  console.log(`   ${assets.length} assets encontrados`);

  // Create backup folder
  const ts = timestamp();
  const info = getVersionInfo();
  const newVersion = bumpVersion(info);
  const backupName = `v${newVersion}_${ts}`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  ensureDir(backupPath);

  // Download each asset
  let downloaded = 0;
  let errors = 0;
  const manifest = {
    version: newVersion,
    timestamp: new Date().toISOString(),
    tag: tag || `Backup v${newVersion}`,
    themeId: THEME_ID,
    assetCount: 0,
    assets: []
  };

  for (const asset of assets) {
    const key = asset.key;
    try {
      const resp = await shopifyAPI('GET', `/themes/${THEME_ID}/assets.json?asset[key]=${encodeURIComponent(key)}`);
      const assetData = resp?.asset;
      if (!assetData) {
        errors++;
        continue;
      }

      const filePath = path.join(backupPath, key);
      ensureDir(path.dirname(filePath));

      if (assetData.attachment) {
        // Binary content (images, fonts)
        fs.writeFileSync(filePath, Buffer.from(assetData.attachment, 'base64'));
      } else if (assetData.value !== undefined) {
        // Text content (liquid, js, css, json)
        fs.writeFileSync(filePath, assetData.value, 'utf8');
      }

      manifest.assets.push({
        key,
        size: assetData.size || 0,
        contentType: assetData.content_type || 'unknown',
        checksum: assetData.checksum || null,
        updatedAt: assetData.updated_at || null
      });

      downloaded++;
      if (downloaded % 10 === 0) {
        process.stdout.write(`   ${downloaded}/${assets.length} descargados...\r`);
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error(`   ⚠️ Error descargando ${key}: ${e.message}`);
      errors++;
    }
  }

  manifest.assetCount = downloaded;
  fs.writeFileSync(path.join(backupPath, '_manifest.json'), JSON.stringify(manifest, null, 2));

  // Update version info
  info.lastBackup = backupName;
  info.backups.push({
    name: backupName,
    version: newVersion,
    timestamp: manifest.timestamp,
    tag: manifest.tag,
    assetCount: downloaded
  });
  saveVersionInfo(info);

  console.log(`\n✅ Backup completado: ${backupName}`);
  console.log(`   ${downloaded} assets descargados, ${errors} errores`);
  console.log(`   Ubicación: backups/${backupName}/`);

  return backupName;
}

// ---- BACKEND SNAPSHOT ----
function snapshotBackend(backupPath) {
  console.log('📋 Creando snapshot del backend...');
  const srcDir = path.join(backupPath, '_backend');
  ensureDir(srcDir);

  // Copy key backend files
  const filesToBackup = [
    'server.js',
    'package.json',
    'src/adapters/amazon.js',
    'src/adapters/aliexpress.js',
    'src/adapters/base.js',
    'src/pricing.js',
    'src/utils/pricing.js',
    'src/shopify-admin.js',
    'src/routes/admin.js',
    'src/webhooks.js',
    'data/settings.json'
  ];

  let copied = 0;
  for (const file of filesToBackup) {
    const src = path.join(__dirname, '..', file);
    const dst = path.join(srcDir, file);
    if (fs.existsSync(src)) {
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
      copied++;
    }
  }

  console.log(`   ${copied} archivos del backend guardados`);
  return copied;
}

// ---- LIST BACKUPS ----
function listBackups() {
  const info = getVersionInfo();
  if (!info.backups || info.backups.length === 0) {
    console.log('📭 No hay backups registrados');
    return;
  }

  console.log('📋 Backups disponibles:\n');
  console.log('  Version  │ Fecha                │ Assets │ Tag');
  console.log('  ─────────┼──────────────────────┼────────┼─────────────────────────');
  for (const b of info.backups.reverse()) {
    const date = new Date(b.timestamp).toLocaleString('es-US', { dateStyle: 'medium', timeStyle: 'short' });
    console.log(`  v${b.version.padEnd(7)} │ ${date.padEnd(20)} │ ${String(b.assetCount || '?').padEnd(6)} │ ${b.tag || ''}`);
  }
  console.log(`\n  Último backup: ${info.lastBackup}`);
  console.log(`  Versión actual: v${info.version}`);
}

// ---- ROLLBACK ----
async function rollback(targetTag) {
  const info = getVersionInfo();
  const backup = info.backups.find(b =>
    b.name === targetTag ||
    b.version === targetTag ||
    `v${b.version}` === targetTag
  );

  if (!backup) {
    console.error(`❌ Backup "${targetTag}" no encontrado`);
    console.log('   Usa --list para ver backups disponibles');
    return;
  }

  const backupPath = path.join(BACKUP_DIR, backup.name);
  const manifestPath = path.join(backupPath, '_manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest no encontrado en ${backupPath}`);
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`🔄 Restaurando backup: ${backup.name} (${manifest.assetCount} assets)`);
  console.log(`   Tag: ${manifest.tag}`);
  console.log('');

  let restored = 0;
  let errors = 0;

  for (const asset of manifest.assets) {
    const filePath = path.join(backupPath, asset.key);
    if (!fs.existsSync(filePath)) {
      console.log(`   ⚠️ Archivo no encontrado: ${asset.key}`);
      errors++;
      continue;
    }

    try {
      const isBinary = asset.contentType && (
        asset.contentType.startsWith('image/') ||
        asset.contentType.includes('font') ||
        asset.contentType.includes('octet-stream')
      );

      const body = { asset: { key: asset.key } };
      if (isBinary) {
        body.asset.attachment = fs.readFileSync(filePath).toString('base64');
      } else {
        body.asset.value = fs.readFileSync(filePath, 'utf8');
      }

      await shopifyAPI('PUT', `/themes/${THEME_ID}/assets.json`, body);
      restored++;

      if (restored % 5 === 0) {
        process.stdout.write(`   ${restored}/${manifest.assetCount} restaurados...\r`);
      }

      // Delay to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`   ❌ Error restaurando ${asset.key}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n✅ Rollback completado`);
  console.log(`   ${restored} assets restaurados, ${errors} errores`);

  // Log rollback in changelog
  appendChangelog(`### Rollback to ${backup.name}\n- Restored ${restored} assets from backup v${backup.version}\n- Tag: ${manifest.tag}\n`);
}

// ---- DIFF ----
function diffBackup(targetTag) {
  const info = getVersionInfo();
  const backup = info.backups.find(b =>
    b.name === targetTag ||
    b.version === targetTag ||
    `v${b.version}` === targetTag
  );

  if (!backup) {
    console.error(`❌ Backup "${targetTag}" no encontrado`);
    return;
  }

  const backupPath = path.join(BACKUP_DIR, backup.name);
  const manifestPath = path.join(backupPath, '_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('❌ Manifest no encontrado');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`📊 Comparando backup ${backup.name} con archivos locales:\n`);

  // Compare key text files
  const keyFiles = manifest.assets.filter(a =>
    a.key.endsWith('.liquid') || a.key.endsWith('.js') || a.key.endsWith('.css') || a.key.endsWith('.json')
  );

  let changed = 0;
  let identical = 0;
  let missing = 0;

  for (const asset of keyFiles) {
    const backupFile = path.join(backupPath, asset.key);
    // Try to find corresponding local file
    const localTheme = path.join(__dirname, '..', 'theme', asset.key);
    if (!fs.existsSync(backupFile)) continue;

    if (!fs.existsSync(localTheme)) {
      missing++;
      continue;
    }

    const backupContent = fs.readFileSync(backupFile, 'utf8');
    const localContent = fs.readFileSync(localTheme, 'utf8');

    if (backupContent !== localContent) {
      console.log(`  📝 MODIFICADO: ${asset.key}`);
      changed++;
    } else {
      identical++;
    }
  }

  console.log(`\n  Resumen: ${changed} modificados, ${identical} idénticos, ${missing} solo en backup`);
}

// ---- CHANGELOG ----
function appendChangelog(entry) {
  const date = new Date().toISOString().split('T')[0];
  const header = `## [${date}]\n`;
  let content = '';

  if (fs.existsSync(CHANGELOG_FILE)) {
    content = fs.readFileSync(CHANGELOG_FILE, 'utf8');
  } else {
    content = '# DealsHub / StyleHub Miami — Changelog\n\nRegistro de todos los cambios realizados en el proyecto.\n\n---\n\n';
  }

  // Insert after the header section
  const insertPoint = content.indexOf('---\n\n');
  if (insertPoint > -1) {
    content = content.substring(0, insertPoint + 5) + header + entry + '\n' + content.substring(insertPoint + 5);
  } else {
    content += header + entry + '\n';
  }

  fs.writeFileSync(CHANGELOG_FILE, content);
}

// ---- CLI ----
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    listBackups();
    return;
  }

  if (args.includes('--rollback')) {
    const idx = args.indexOf('--rollback');
    const target = args[idx + 1];
    if (!target) {
      console.error('Uso: node scripts/backup.js --rollback <version|nombre>');
      return;
    }
    await rollback(target);
    return;
  }

  if (args.includes('--diff')) {
    const idx = args.indexOf('--diff');
    const target = args[idx + 1];
    if (!target) {
      console.error('Uso: node scripts/backup.js --diff <version|nombre>');
      return;
    }
    diffBackup(target);
    return;
  }

  // Default: full backup
  const tag = args.includes('--tag')
    ? args[args.indexOf('--tag') + 1] || ''
    : args.filter(a => !a.startsWith('--')).join(' ') || '';

  const themeOnly = args.includes('--theme-only');

  if (!SHOPIFY_TOKEN) {
    console.error('❌ SHOPIFY_ADMIN_TOKEN no configurado');
    console.log('   Exporta la variable: export SHOPIFY_ADMIN_TOKEN=tu_token');
    console.log('   O ejecuta desde el directorio del proyecto con .env');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  DealsHub — Backup & Versioning System');
  console.log('═══════════════════════════════════════════════\n');

  const backupName = await backupTheme(tag);

  if (backupName && !themeOnly) {
    const backupPath = path.join(BACKUP_DIR, backupName);
    snapshotBackend(backupPath);
  }

  // Update changelog
  if (backupName) {
    const info = getVersionInfo();
    appendChangelog(`### Backup v${info.version}\n- ${tag || 'Full backup'}\n- Theme + Backend snapshot\n`);
    console.log('\n📝 Changelog actualizado');
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('  Backup completado exitosamente');
  console.log('═══════════════════════════════════════════════');
}

main().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
