// Every non-secret setting the functions read must be in functions/.env: an unattended deploy (GitHub Actions)
// stops with "In non-interactive mode but have no value for …" for any that's missing, even with a default in code.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'firebase-tools/lib/functions/env.js';

describe('functions/.env', () => {
  it('has a value for every parameter', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const params = [...source.matchAll(/define(?:String|Int|Float|Boolean|List)\('(\w+)'/g)].map((m) => m[1]);
    expect(params.length).toBeGreaterThan(0);
    const { envs, errors } = parse(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
    expect(errors).toEqual([]);
    expect(params.filter((p) => !(p in envs))).toEqual([]);
  });
});
