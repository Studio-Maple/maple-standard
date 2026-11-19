#!/usr/bin/env node
/**
 * build-top-names.mjs - regenerate data/top-npm.json and data/top-pypi.json, the popular-package name lists the
 * typosquat check (D080) compares new package names against. Names only, sorted, no secrets.
 *
 *   node build-top-names.mjs [--count 5000] [--max-minutes 15] [--pypi-only | --npm-only]
 *
 * PyPI: hugovk's monthly top-pypi-packages list (ClickHouse download counts), first N.
 * npm:  there is no public "top N" endpoint, so the registry search API (popularity-weighted, returns weekly
 *       downloads per hit) is swept with many queries and the union is cut to the N highest weekly downloads.
 *       The sweep is a best effort: the result file records how many names it reached in its `count` field.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const PYPI_URL = "https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json";
const SEARCH = "https://registry.npmjs.org/-/v1/search";
const PAGE = 250;
const MAX_FROM = 1250;
const CONCURRENCY = 6;

const TERMS = ("react vue angular svelte next nuxt express koa fastify nest webpack vite rollup esbuild babel eslint prettier typescript jest vitest mocha chai sinon " +
  "cypress playwright puppeteer lodash underscore ramda moment dayjs date-fns luxon axios got node-fetch ky superagent request undici zod yup joi valibot ajv " +
  "uuid nanoid dotenv yargs commander minimist chalk colors kleur glob fast-glob globby rimraf mkdirp fs-extra winston pino bunyan debug ws socket.io graphql apollo " +
  "redux mobx zustand jotai recoil swr query router form tailwind postcss sass less styled emotion css classnames clsx aws azure google firebase supabase stripe " +
  "mongodb mongoose sequelize prisma typeorm knex pg mysql redis sqlite jwt passport bcrypt crypto oauth auth cors helmet cookie session multer body-parser " +
  "markdown yaml json xml csv parser stream buffer promise async await events emitter queue cache lru memoize retry throttle debounce validator sanitize " +
  "types plugin cli util utils helper config loader polyfill shim compat core common shared hooks components icons ui kit design charts d3 three canvas image " +
  "sharp jimp pdf excel docx zip tar compress gzip brotli crypto-js hash md5 sha base64 url path os fs process child exec spawn cross-env shell " +
  "test mock stub fixture coverage lint format husky lint-staged semver npm yarn pnpm lerna nx turbo monorepo docker kubernetes terraform ansible " +
  "babel-plugin eslint-plugin eslint-config postcss-plugin webpack-plugin rollup-plugin vite-plugin react-native expo ionic electron tauri node deno bun " +
  "tslib core-js regenerator-runtime object-assign inherits safe-buffer readable-stream string_decoder isarray ms bluebird async-lock p-limit p-map p-queue").split(/\s+/);

const letters = "abcdefghijklmnopqrstuvwxyz";
const pairs = [];
for (const a of letters) for (const b of letters) pairs.push(a + b);

async function getJson(url, tries = 2) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return await res.json();
      if (res.status === 429) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      else if (res.status >= 400 && res.status < 500) return null;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return null;
}

async function pypi(count) {
  const doc = await getJson(PYPI_URL);
  const names = (doc?.rows ?? []).slice(0, count).map((r) => String(r.project).toLowerCase());
  if (names.length < 1000) throw new Error(`PyPI list too short (${names.length})`);
  return names;
}

async function npm(count, maxMinutes) {
  const stopAt = Date.now() + maxMinutes * 60_000;
  const seen = new Map(); // name -> weekly downloads
  const queue = [...new Set([...TERMS, ...pairs])];
  let done = 0;
  const worker = async () => {
    while (queue.length && Date.now() < stopAt) {
      const text = queue.shift();
      for (let from = 0; from < MAX_FROM; from += PAGE) {
        const j = await getJson(`${SEARCH}?text=${encodeURIComponent(text)}&popularity=1.0&quality=0&maintenance=0&size=${PAGE}&from=${from}`);
        const objs = j?.objects ?? [];
        let fresh = 0;
        for (const o of objs) {
          const name = o?.package?.name;
          if (typeof name === "string" && !seen.has(name)) { seen.set(name, o.downloads?.weekly ?? 0); fresh += 1; }
        }
        if (objs.length < PAGE || fresh === 0) break;
      }
      done += 1;
      if (done % 100 === 0) console.error(`npm: ${done} queries, ${seen.size} names`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, count).map(([n]) => n.toLowerCase());
}

const args = process.argv.slice(2);
const count = Number(args[args.indexOf("--count") + 1]) || 5000;
const maxMinutes = Number(args[args.indexOf("--max-minutes") + 1]) || 15;
const write = (file, source, names) => {
  const sorted = [...new Set(names)].sort();
  writeFileSync(join(DATA, file), JSON.stringify({ source, count: sorted.length, names: sorted }) + "\n");
  console.log(`${file}: ${sorted.length} names`);
};
if (!args.includes("--npm-only")) write("top-pypi.json", PYPI_URL, await pypi(count));
if (!args.includes("--pypi-only")) write("top-npm.json", `${SEARCH} (popularity sweep, cut to weekly downloads)`, await npm(count, maxMinutes));
