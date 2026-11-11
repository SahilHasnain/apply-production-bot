import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(TOOL_DIR, 'apps.json');
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.nearbook-play-profiles');
const DEFAULT_TIMEOUT_MIN = 10;

const DEFAULT_APP_LIST_URL = 'https://play.google.com/console/u/0/developers/8815803363466457497/app-list';

const HELP = `Apply-for-Production Bot - fill Google Play Console 'Apply for production' answers for your apps.

Usage:
  node apply.js seed    [--config FILE] [--profile-dir D] [--timeout MIN]
      One-time: signs into the Google developer account in its own persistent Chrome profile.
      A Chrome window opens; sign in manually, the script detects success.

  node apply.js status  [--config FILE] [--profile-dir D]
      Shows whether the developer profile is signed in.

  node apply.js fill    [--config FILE] [--profile-dir D] [--app PACKAGE] [--submit] [--headless]
      For each app in config, opens its 'Apply for production' form and fills the 7 answers.
      Default is fill-only (dry run); pass --submit to actually submit.
      --app can be repeated or comma-separated: --app com.a --app com.b

Options:
  --config FILE     Apps config JSON (default: apps.json next to this script)
  --profile-dir D   Where the developer Chrome profile lives (default ~/.nearbook-play-profiles)
  --timeout MIN     Seed: minutes to wait for manual sign-in (default 10)
  --app PACKAGE     Only fill these packages; repeatable or comma-separated
                    (default: all apps in config)
  --submit          Actually submit the form (default is dry-run only)
  --stop-on-error   Stop after the first app that fails (default: continue)
  --headless        Run Chrome headless (not recommended; Google may block)

Workflow:
  1) node apply.js seed    - do this once; sign into your Play Console developer account
  2) node apply.js status  - confirm you're signed in
  3) node apply.js fill    - fill answers for every app (dry run)
  4) node apply.js fill --submit  - fill AND submit when you're ready

Config (apps.json):
  Each app needs: package, appName, track, and an "answers" object whose keys
  are the 7 question prompts and values the answers (each <= 300 chars).
  Add more apps by appending entries to the "apps" array.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        // `--app` is repeatable: `--app a --app b` should mean both apps,
        // not just the last one.
        if (key === 'app' && args[key] !== undefined) {
          args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
        } else {
          args[key] = next;
        }
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

function numArg(args, key, fallback) {
  const v = args[key];
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function loadConfig(args) {
  const cfgPath = resolveHome(args.config || args['config-file'] || DEFAULT_CONFIG);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const profileDir = resolveHome(args['profile-dir'] || cfg.profileDir || DEFAULT_PROFILE_DIR);
  return { cfg, profileDir, cfgPath };
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

async function checkSignedIn(ctx) {
  try {
    const cookies = await ctx.cookies('https://www.google.com');
    return cookies.some((c) => ['SID', 'SAPISID'].includes(c.name));
  } catch (e) {
    if (/closed|crash/i.test(String(e.message || e))) throw e;
    return false;
  }
}

async function waitSignedIn(ctx, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      if (await checkSignedIn(ctx)) return true;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  return false;
}

async function cmdSeed(args) {
  const { profileDir } = loadConfig(args);
  const timeoutMs = numArg(args, 'timeout', DEFAULT_TIMEOUT_MIN) * 60_000;
  const maxAttempts = 5;
  fs.mkdirSync(profileDir, { recursive: true });
  const profile = profilePath(profileDir);
  fs.mkdirSync(profile, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let signedIn = false;
  for (let attempt = 1; attempt <= maxAttempts && !signedIn && Date.now() < deadline; attempt++) {
    let ctx;
    try {
      ctx = await launch(profile);
      if (await checkSignedIn(ctx)) {
        log('already signed in, skipping');
        signedIn = true;
        break;
      }
      const page = await ctx.newPage();
      await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      log(`Chrome opened (attempt ${attempt}) - sign into your Play Console developer account now`);
      signedIn = await waitSignedIn(ctx, deadline);
    } catch (e) {
      log(`browser closed unexpectedly (${String(e.message || e).split('\n')[0].slice(0, 80)}), reopening`);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }
  log(signedIn ? 'signed in OK' : `NOT signed in (timeout after ${maxAttempts} attempts)`);
}

async function cmdStatus(args) {
  const { profileDir } = loadConfig(args);
  const profile = profilePath(profileDir);
  if (!fs.existsSync(profile)) {
    log('no profile yet (never seeded)');
    return;
  }
  const ctx = await launch(profile);
  try {
    const ok = await checkSignedIn(ctx);
    log(ok ? 'signed in' : 'not signed in');
  } finally {
    await ctx.close().catch(() => {});
  }
}

function selectApps(cfg, filter) {
  let apps = cfg.apps || [];
  const rawFilters = Array.isArray(filter) ? filter : filter ? [filter] : [];
  const filters = rawFilters
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (filters.length > 0) {
    apps = apps.filter((a) => filters.includes(a.package) || filters.includes(a.appName));
    if (apps.length === 0) {
      throw new Error(`no app in config matches '${filters.join(', ')}'`);
    }
  }
  return apps;
}

async function fillAppForm(ctx, app, submit) {
  const page = await ctx.newPage();
  const results = [];
  try {
    const targetUrl = await navigateToProductionAccess(page, app);
    log(`${app.appName}: opened ${targetUrl}`);

    const answerSteps = app.steps || [Object.keys(app.answers || {})];
    for (let step = 1; step <= answerSteps.length; step++) {
      const visibleFields = page.locator('textarea:visible');
      const fieldCount = await visibleFields.count().catch(() => 0);
      for (let i = 0; i < answerSteps[step - 1].length; i++) {
        const question = answerSteps[step - 1][i];
        const answer = app.answers?.[question];
        const field = visibleFields.nth(i);
        const filled = i < fieldCount;
        if (filled) {
          await field.scrollIntoViewIfNeeded().catch(() => {});
          await field.fill(answer, { timeout: 10000 });
        }
        results.push({ question, status: filled ? 'FILLED' : 'FIELD-NOT-FOUND', step });
        log(`${app.appName} / step ${step}: ${filled ? 'filled' : 'NOT FOUND'} - ${question.slice(0, 50)}`);
      }

      for (const mcq of app.mcq || []) {
        if ((mcq.step || 1) === step) {
          const filled = await fillMcq(page, mcq);
          results.push({ question: mcq.question, selection: mcq.selection, status: filled ? 'SELECTED' : 'OPTION-NOT-FOUND', step });
          log(`${app.appName} / step ${step} MCQ: ${filled ? 'selected' : 'NOT FOUND'} - ${mcq.selection}`);
        }
      }

      if (step < answerSteps.length) {
        const next = page.getByRole('button', { name: /^next$/i }).last();
        if ((await next.count().catch(() => 0)) === 0) throw new Error(`Next button not found after production form step ${step}`);
        await next.scrollIntoViewIfNeeded().catch(() => {});
        await next.click({ timeout: 15000 });
        await page.waitForTimeout(2500);
      }
    }

    if (submit) {
      const submitted = await submitForm(page, app.reviewConsent || {});
      if (!submitted) throw new Error(`${app.appName}: final Apply button was not clicked`);
      results.push({ action: 'SUBMIT', status: submitted ? 'SUBMITTED' : 'SUBMIT-NOT-FOUND' });
    } else {
      log(`${app.appName}: dry run - NOT submitting. Re-run with --submit.`);
    }

    // Persist a screenshot regardless, so the user can eyeball the filled form.
    const shot = path.join(process.cwd(), `apply-${app.package}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    if (fs.existsSync(shot)) results.push({ action: 'SCREENSHOT', path: shot });
  } catch (e) {
    results.push({ action: 'ERROR', detail: String(e).slice(0, 200) });
    // Capture the page even when filling fails. This is how we catch cases
    // where the bot opened the wrong app before any fields were filled.
    const shot = path.join(process.cwd(), `apply-${app.package}-error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    if (fs.existsSync(shot)) results.push({ action: 'SCREENSHOT', path: shot });
  } finally {
    await page.close().catch(() => {});
  }
  return results;
}

async function navigateToProductionAccess(page, app) {
  const appListUrl = app.appListUrl || DEFAULT_APP_LIST_URL;
  await page.goto(appListUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);

  // Filter the app list before inspecting rows. This is more reliable than
  // depending on the list's virtualized scrolling behavior.
  const search = page.locator('input[placeholder*="search" i], input[aria-label*="search" i], input[type="search"]').first();
  if ((await search.count().catch(() => 0)) > 0 && await search.isVisible().catch(() => false)) {
    await search.fill(app.package).catch(() => {});
    await page.waitForTimeout(2500);
  }

  // The app list has a page-size control. Showing 100 rows avoids relying on
  // virtualized pagination when the account contains many apps.
  const showRows = page.getByText(/show rows/i).first();
  if ((await showRows.count().catch(() => 0)) > 0) {
    await showRows.click().catch(() => {});
    await page.waitForTimeout(500);
    const rows100 = page.getByText('100', { exact: true }).last();
    if ((await rows100.count().catch(() => 0)) > 0) {
      await rows100.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }

  // Play Console virtualizes this list, so rows below the fold are not in the
  // DOM until the list is scrolled. Search after each scroll increment.
  let href = null;
  const wantedPackage = app.package.toLowerCase();
  const wantedName = app.appName.toLowerCase();
  for (let attempt = 0; attempt < 40 && !href; attempt++) {
    const candidates = await page.locator('a[href*="/app/"][href*="app-dashboard"]').evaluateAll((links) => {
      const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      return links.map((link) => {
        const ownText = normalize([
          link.innerText,
          link.textContent,
          link.getAttribute('aria-label'),
          link.getAttribute('title'),
        ].filter(Boolean).join(' '));

        // Only use the closest row-like container. Walking many ancestors can
        // pick up the whole app list, which contains every app name and makes
        // the first link in the list look like a match for every package.
        let rowText = ownText;
        const row = link.closest('tr, [role="row"], li, [role="listitem"]');
        if (row) {
          const text = normalize(row.innerText);
          if (text && text.length <= 500) rowText = text;
        } else {
          // Some Play Console tables use plain divs. Use a nearby parent only
          // while its text is small enough to belong to one row, never the
          // whole list container.
          let parent = link.parentElement;
          for (let i = 0; i < 3 && parent; i++, parent = parent.parentElement) {
            const text = normalize(parent.innerText);
            if (text && text.length <= 300) {
              rowText = text;
              break;
            }
          }
        }

        return { href: link.href, ownText, rowText };
      });
    });

    const target = candidates.find((candidate) => candidate.ownText.includes(wantedPackage) || candidate.ownText.includes(wantedName))
      || candidates.find((candidate) => candidate.rowText.includes(wantedPackage) || candidate.rowText.includes(wantedName));
    href = target?.href || null;
    if (href) break;

    await page.mouse.wheel(0, 900);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
          element.scrollTop += 900;
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(700);
  }

  if (!href) throw new Error(`${app.appName} (${app.package}) was not found in the Play Console app list`);
  const dashboardUrl = new URL(href, appListUrl).toString();
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // Never fill a form until we have confirmed that the dashboard belongs to
  // the app we selected. Without this, a bad row match silently submits one
  // app's answers to another app.
  const dashboardText = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
  if (!dashboardText.includes(wantedName) && !dashboardText.includes(wantedPackage)) {
    throw new Error(`Opened the wrong app: expected ${app.appName} (${app.package}); current URL ${page.url()}`);
  }

  // Some Play Console dashboards expose the action directly on the app
  // overview. Prefer that visible button when present.
  await clickApplyForProduction(page);

  // Prefer a rendered navigation link containing closed-testing. This keeps
  // navigation resilient to Play Console's changing internal app IDs.
  const testingLink = page.locator('a[href*="closed-testing"], a').filter({
    hasText: /closed testing/i,
  }).first();
  if ((await testingLink.count().catch(() => 0)) > 0) {
    await testingLink.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(6000);
  }

  const productionLink = page.locator('a[href*="production-access"], a').filter({
    hasText: /apply for production|production access/i,
  }).first();
  if ((await productionLink.count().catch(() => 0)) > 0) {
    await productionLink.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  const text = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  if (/application submitted|we have your application/i.test(text)) {
    throw new Error(`${app.appName} already has a production access application submitted; current URL: ${page.url()}`);
  }
  if (!/apply for production|production access|recruit testers|closed testing/i.test(text)) {
    throw new Error(`Could not reach the closed-testing production form; current URL: ${page.url()}`);
  }
  const visibleTextareas = await page.locator('textarea:visible').count().catch(() => 0);
  if (visibleTextareas === 0) {
    throw new Error(`Reached ${page.url()} but no production form fields are visible for ${app.appName} (${app.package})`);
  }
  return page.url();
}

async function clickApplyForProduction(page) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidates = page.locator('button, [role="button"], a, [role="link"]').filter({
      hasText: /apply for production/i,
    });
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click({ timeout: 15000, force: true }).catch(() => {});
      await page.waitForTimeout(6000);
      return true;
    }

    await page.mouse.wheel(0, 700);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
          element.scrollTop += 700;
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(700);
  }
  return false;
}

async function fillQuestion(page, question, answer) {
  const heading = page.getByText(question, { exact: false }).first();
  if ((await heading.count().catch(() => 0)) === 0) return false;

  // Each prompt and textarea share a question container. Walk upward until
  // that container exposes the current step's visible textarea.
  let container = heading;
  for (let level = 0; level < 8; level++) {
    const field = container.locator('textarea:visible').first();
    if ((await field.count().catch(() => 0)) > 0) {
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await field.fill(answer, { timeout: 10000 });
      return true;
    }
    container = container.locator('xpath=..');
  }
  return false;
}

async function fillMcq(page, mcq) {
  const wanted = normalize(mcq.selection);
  const options = page.locator('label, [role="radio"], [role="checkbox"]');
  const count = await options.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = normalize(await option.innerText().catch(() => ''));
    if (text !== wanted || !(await option.isVisible().catch(() => false))) continue;
    await option.scrollIntoViewIfNeeded().catch(() => {});
    await option.click({ force: true });
    return true;
  }
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function submitForm(page, consent) {
  // Play Console exposes the final action as a plain "Apply" button on the
  // last form step. Do not click Next here: it can advance the wrong mounted
  // step in the SPA and leave the form invalid.
  const directApply = page.locator('button[aria-label="Apply"], [role="button"][aria-label="Apply"]').last();
  const directCount = await directApply.count().catch(() => 0);
  let btn = directCount > 0 && await directApply.isVisible().catch(() => false) && await directApply.isEnabled().catch(() => false) ? directApply : null;
  const candidates = page.locator('button, [role="button"]');
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count && !btn; i++) {
    const candidate = candidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = ((await candidate.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!/^(apply|submit|send for review)(\s+for production)?$/i.test(text)) continue;
    btn = candidate;
    break;
  }
  if (!btn) return false;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await btn.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  if (!(await btn.isEnabled().catch(() => false))) return false;
  await btn.click({ timeout: 15000, force: true });
  await page.waitForTimeout(2500);
  // The Play Console button is a custom Material control. If its click did
  // not change the UI, invoke the native DOM click once as a fallback.
  if (await btn.isVisible().catch(() => false)) {
    await btn.evaluate((element) => element.click()).catch(() => {});
    await page.waitForTimeout(2500);
  }
  // Handle any consent/dialog confirm if requested in config.
  if (consent && consent.text) {
    const confirm = page.getByRole('button', { name: new RegExp(consent.text, 'i') }).first();
    if ((await confirm.count().catch(() => 0)) > 0) await confirm.click({ timeout: 8000 }).catch(() => {});
  }
  const body = ((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  return !/to continue, fix errors|fix errors before continuing/i.test(body);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

function keywordsOf(normalized) {
  const stop = new Set(['how', 'did', 'your', 'the', 'for', 'what', 'and', 'that', 'describe']);
  return normalized.split(/\s+/).filter((w) => w.length > 3 && !stop.has(w)).slice(0, 6);
}

function anyKeyword(normalized) {
  const kw = keywordsOf(normalized);
  return kw.length ? kw[0] : normalized;
}

async function cmdFill(args) {
  const { cfg, profileDir } = loadConfig(args);
  const headless = !!args.headless;
  const submit = !!args.submit;
  const stopOnError = !!args['stop-on-error'];
  const apps = selectApps(cfg, args.app);

  const profile = profilePath(profileDir);
  if (!fs.existsSync(profile)) {
    log('no developer profile yet - run: node apply.js seed');
    return;
  }

  const allResults = [];
  const ctx = await launch(profile, headless);
  try {
    if (!(await checkSignedIn(ctx))) {
      log('not signed in - run: node apply.js seed');
      return;
    }
    for (const app of apps) {
      const r = await fillAppForm(ctx, app, submit);
      allResults.push({ package: app.package, appName: app.appName, ...r });
      if (stopOnError && r.some((entry) => entry.action === 'ERROR')) {
        log(`${app.appName}: stopping after failure (--stop-on-error); no other app will be opened`);
        break;
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  const outFile = path.join(process.cwd(), `apply-results-${Date.now()}.jsonl`);
  fs.writeFileSync(outFile, allResults.map((r) => JSON.stringify(r)).join('\n') + '\n');
  log(`wrote results to ${outFile}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === 'seed') {
  await cmdSeed(args);
} else if (cmd === 'status') {
  await cmdStatus(args);
} else if (cmd === 'fill') {
  await cmdFill(args);
} else {
  console.log(HELP);
}
