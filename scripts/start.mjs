#!/usr/bin/env node
/*
 * Start pi Web, first checking whether a newer pi SDK is published.
 *
 * The wrapper exists so an update happens before server.js imports the SDK.
 * Interactive terminals are asked; non-interactive starts only print a hint.
 * Set PI_WEB_SDK_UPDATE=off (or PI_WEB_SKIP_SDK_UPDATE=1) to skip the check,
 * or PI_WEB_SDK_UPDATE=auto to update without asking.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@earendil-works/pi-coding-agent';
const REGISTRY_TIMEOUT_MS = 4000;

function parseVersion(value) {
  const [core, pre = ''] = String(value).replace(/^v/, '').split('-', 2);
  const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (numbers.length < 3) numbers.push(0);
  return { numbers, pre };
}

/** Compare two semver-ish versions. Returns 1, 0 or -1. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) {
      return left.numbers[i] > right.numbers[i] ? 1 : -1;
    }
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

export async function installedSdkVersion() {
  try {
    const file = path.join(ROOT, 'node_modules', ...PACKAGE.split('/'), 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export async function latestSdkVersion() {
  const registry = (process.env.PI_WEB_NPM_REGISTRY
    || process.env.npm_config_registry
    || 'https://registry.npmjs.org/').replace(/\/?$/, '/');
  const name = PACKAGE.replace('/', '%2F');
  const response = await fetch(`${registry}${name}/latest`, {
    headers: { accept: 'application/json', 'User-Agent': 'pi-web' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const data = await response.json();
  return typeof data?.version === 'string' ? data.version : null;
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function startServer(extraArgs) {
  let args = ['server.js', ...extraArgs];
  if (extraArgs.includes('--watch')) {
    args = ['--watch', 'server.js', ...extraArgs.filter((arg) => arg !== '--watch')];
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = (signal) => {
      try { child.kill(signal); } catch {}
    };
    for (const signal of signals) process.on(signal, forward);
    child.on('error', (err) => {
      console.error(`Could not start server.js: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      for (const signalName of signals) process.off(signalName, forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const mode = (process.env.PI_WEB_SDK_UPDATE || '').toLowerCase();
  const disabled = mode === 'off' || process.env.PI_WEB_SKIP_SDK_UPDATE === '1';

  if (!disabled) {
    const current = await installedSdkVersion();
    if (current) {
      let latest = null;
      try {
        latest = await latestSdkVersion();
      } catch (err) {
        if (process.env.PI_WEB_SDK_UPDATE_DEBUG === '1') {
          console.warn(`[sdk] version check failed: ${err.message}`);
        }
      }

      if (latest && compareVersions(latest, current) > 0) {
        let update = mode === 'auto';
        const interactive = process.stdin.isTTY && process.stdout.isTTY;
        if (!update && interactive) {
          const answer = await ask(`\n  pi SDK ${current} → ${latest} 可用。现在更新并启动? [y/N] `);
          update = /^y(es)?$/i.test(answer);
        } else if (!update) {
          console.log(`\n  pi SDK ${current} → ${latest} 可用（非交互启动，未自动更新）`);
          console.log(`  手动更新: npm install --ignore-scripts ${PACKAGE}@latest\n`);
        }

        if (update) {
          console.log(`\n  Updating ${PACKAGE} to ${latest}…`);
          const code = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE}@latest`]);
          if (code === 0) {
            console.log(`  Updated to ${latest}. Starting…\n`);
          } else {
            console.warn('  SDK update failed; starting with the installed version.\n');
          }
        }
      }
    }
  }

  return startServer(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
