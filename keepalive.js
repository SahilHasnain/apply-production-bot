import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regularly signs into the Play Console with the persistent developer profile so
// the account keeps showing routine activity from this machine. Google can still
// invalidate a session on its own (password change, "sign out everywhere", risk
// flags), so treat this as risk reduction, not a guarantee.

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(TOOL_DIR, 'apps.json');
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.nearbook-play-profiles');
const DEFAULT_APP_LIST_URL =
  'https://play.google.com/console/u/0/developers/8815803363466457497/app-list';

const HELP = `Keep-alive - visits the Play Console so the developer session stays active.

Usage:
  node keepalive.js [--config FILE] [--profile-dir D] [--headless] [--dry-run]

Exit codes:
  0  session is alive (or dry run requested)
  1  session is invalid or the console was unreachable - run: node apply.js seed
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function resolveHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function profilePath(dir) {
  return path.join(dir, 'developer');
}

async function launch(profile, headless = false) {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// A SID cookie can survive a revoked session, so cookie presence is not proof.
// The console redirecting to accounts.google.com is the reliable signal.
function sessionLooksDead(url, body) {
  if (/accounts\.google\.com|\/ServiceLogin/.test(url)) return true;
  return /sign in to google|choose an account/i.test(body || '');
}

async function main(args) {
  const cfgPath = resolveHome(args.config || DEFAULT_CONFIG);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const profileDir = resolveHome(args['profile-dir'] || cfg.profileDir || DEFAULT_PROFILE_DIR);
  const profile = profilePath(profileDir);
  const appListUrl = cfg.appListUrl || DEFAULT_APP_LIST_URL;
  const headless = !!args.headless;

  if (!fs.existsSync(profile)) {
    log('no developer profile yet - run: node apply.js seed');
    return 1;
  }

  if (args['dry-run']) {
    log('dry run: would visit the app list and each app dashboard');
    return 0;
  }

  const pages = [];
  let ctx;
  try {
    ctx = await launch(profile, headless);
    const page = await ctx.newPage();
    pages.push(page);

    await page.goto(appListUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    let body = await page.locator('body').innerText().catch(() => '');
    if (sessionLooksDead(page.url(), body)) {
      log('session INVALID - run: node apply.js seed');
      pages.push({ action: 'INVALID', at: page.url() });
      return 1;
    }
    log(`app list reachable (${page.url()})`);
    pages.push({ action: 'APP_LIST', status: 'OK', at: page.url() });

    for (const app of cfg.apps || []) {
      const found = await findDashboardLink(page, app, appListUrl);
      if (!found) {
        log(`${app.appName}: dashboard link not found, skipping`);
        pages.push({ package: app.package, action: 'DASHBOARD', status: 'NOT-FOUND' });
        continue;
      }
      await page.goto(found, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
      body = await page.locator('body').innerText().catch(() => '');
      if (sessionLooksDead(page.url(), body)) {
        log('session INVALID while opening an app - run: node apply.js seed');
        pages.push({ package: app.package, action: 'INVALID', at: page.url() });
        return 1;
      }
      log(`${app.appName}: dashboard visited`);
      pages.push({ package: app.package, action: 'DASHBOARD', status: 'OK', at: page.url() });
    }

    log('session alive');
    return 0;
  } catch (e) {
    log(`error: ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
    pages.push({ action: 'ERROR', detail: String(e.message || e).slice(0, 200) });
    return 1;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    const outFile = path.join(TOOL_DIR, `keepalive-${Date.now()}.jsonl`);
    fs.writeFileSync(outFile, pages.map((p) => JSON.stringify(p)).join('\n') + '\n');
    log(`wrote results to ${outFile}`);
  }
}

async function findDashboardLink(page, app, appListUrl) {
  const search = page
    .locator('input[placeholder*="search" i], input[aria-label*="search" i], input[type="search"]')
    .first();
  if ((await search.count().catch(() => 0)) > 0 && (await search.isVisible().catch(() => false))) {
    await search.fill(app.package).catch(() => {});
    await page.waitForTimeout(2500);
  }

  let href = null;
  for (let attempt = 0; attempt < 20 && !href; attempt++) {
    const rows = await page
      .locator('a[href*="/app/"][href*="app-dashboard"]')
      .evaluateAll((links) =>
        links.map((link) => {
          const texts = [];
          let row = link;
          for (let i = 0; i < 12 && row; i++, row = row.parentElement) {
            texts.push(row.innerText || '');
          }
          return { href: link.href, texts };
        }),
      );
    const match = rows.find((candidate) =>
      candidate.texts.some((value) => {
        const text = value.toLowerCase();
        return (
          text.includes(app.package.toLowerCase()) || text.includes(app.appName.toLowerCase())
        );
      }),
    );
    href = match?.href || null;
    if (href) break;

    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(700);
  }
  return href ? new URL(href, appListUrl).toString() : null;
}

const args = parseArgs(process.argv.slice(2));
if (args._[0] && !['run', 'keepalive'].includes(args._[0])) {
  console.log(HELP);
} else {
  process.exitCode = await main(args);
}
