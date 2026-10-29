#!/usr/bin/env node
// Prints the case catalog. Usage: node runner/list-cases.mjs [--cases=...] [--tags=...] [--markdown]
import { loadCases, filterCases } from './lib/cases.mjs';
import { list } from './lib/env.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const cases = filterCases(loadCases(), { patterns: list(arg('cases')), tags: list(arg('tags')), skipTags: list(arg('skip-tags')) });
const markdown = process.argv.includes('--markdown');

let category = '';
for (const c of cases) {
  if (c.category !== category) {
    category = c.category;
    console.log(markdown ? `\n### ${category}\n\n| Case | What it records | Tags |\n|---|---|---|` : `\n${category}`);
  }
  const needs = [c.requires.plugins ? 'test plugins' : '', ...(c.requires.env || [])].filter(Boolean);
  const tags = c.tags.join(', ') + (needs.length ? ` (needs ${needs.join(', ')})` : '');
  console.log(markdown
    ? `| \`${c.name}\` | ${c.title.replace(/\|/g, '\\|')} | ${tags} |`
    : `  ${c.name.padEnd(44)} ${c.title}  [${tags}]`);
}
console.log(markdown ? '' : `\n${cases.length} case(s)`);
