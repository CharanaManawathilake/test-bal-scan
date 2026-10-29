import fs from 'node:fs';
import path from 'node:path';
import { CASES_DIR } from './env.mjs';

export const CATEGORIES = ['single-files', 'packages', 'workspaces'];

const LOCK_DEPENDENCIES = { name: 'Lock dependencies (bal build)', run: 'bal build' };

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function loadCases() {
  const cases = [];
  for (const category of CATEGORIES) {
    const dir = path.join(CASES_DIR, category);
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'case.json');
      if (!fs.existsSync(file)) {
        continue;
      }
      const def = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Packages and workspaces need a Dependencies.toml for scan 0.13+, so they are built first by default.
      const defaultSetup = category === 'single-files' ? [] : [LOCK_DEPENDENCIES];
      cases.push({
        id: `${category}/${name}`,
        category,
        name,
        dir: path.join(dir, name),
        title: def.title || name,
        description: def.description || '',
        tags: def.tags || [],
        upstream: def.upstream || [],
        requires: def.requires || {},
        notes: def.notes || '',
        setup: (def.setup ?? defaultSetup).map((s) => ({ ...s, setup: true })),
        steps: def.steps || [],
      });
    }
  }
  return cases;
}

export function filterCases(cases, { patterns = [], tags = [], skipTags = [] }) {
  const regexes = patterns.map(globToRegex);
  return cases.filter((c) => {
    if (regexes.length && !regexes.some((r) => r.test(c.id) || r.test(c.name))) {
      return false;
    }
    if (tags.length && !c.tags.some((t) => tags.includes(t))) {
      return false;
    }
    return !c.tags.some((t) => skipTags.includes(t));
  });
}
