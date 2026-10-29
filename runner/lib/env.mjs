import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CASES_DIR = path.join(ROOT, 'cases');
export const RESULTS_DIR = path.join(ROOT, 'results');
export const PLUGINS_OUT_DIR = path.join(ROOT, 'tools', 'test-plugins', 'out');

const SECRET_KEYS = /TOKEN|PASSWORD|SECRET|PAT$/i;

export function parseEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) {
    return values;
  }
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

// Values already exported in the shell win over the .env file, so one-off overrides need no file edit.
export function loadConfig(envFile = path.join(ROOT, '.env')) {
  const fileValues = { ...parseEnvFile(path.join(ROOT, '.env.example')), ...parseEnvFile(envFile) };
  const config = { ...fileValues };
  for (const key of Object.keys(fileValues)) {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      config[key] = process.env[key];
    }
  }
  return config;
}

export function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function bool(value, fallback = false) {
  if (value === undefined || value === '') {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function redact(config) {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEYS.test(key) && value ? '***' : value;
  }
  return out;
}

export function secretValues(config) {
  return Object.entries(config)
    .filter(([key, value]) => SECRET_KEYS.test(key) && value && value.length >= 4)
    .map(([, value]) => value);
}

export function interpolate(text, vars) {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => (name in vars ? vars[name] : match));
}
