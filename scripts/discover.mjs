// Open Seat — descubre empresas nuevas para seguir
// Lo corre .github/workflows/discover.yml una vez por día.
//
// Cómo funciona:
// 1. Common Crawl (un archivo público de la web) tiene un índice de las direcciones que visitó.
//    Le pedimos las páginas de empleo de cada ATS que sabemos leer: jobs.lever.co/…, jobs.ashbyhq.com/…, etc.
// 2. De cada dirección sacamos la empresa (el "slug"). Las que ya seguimos o ya revisamos, se saltean.
// 3. Leemos los avisos de cada empresa nueva. Si tiene al menos un aviso de diseño, producto,
//    desarrollo o datos que se pueda tomar desde Argentina, la sumamos a data/companies.json.
// 4. Guardamos en data/discovery.json qué revisamos y por dónde vamos del índice, para seguir mañana.
//
// Variables opcionales: DISCOVER_BUDGET (empresas a revisar por corrida, 250 por defecto)
//                       DISCOVER_PAGES (páginas del índice por ATS y corrida, 2 por defecto)

import { readFile, writeFile } from "node:fs/promises";
import { detectATS, ATS_FETCHERS } from "./ingest.mjs";

const ROOT = new URL("../", import.meta.url);
const COMPANIES_FILE = new URL("data/companies.json", ROOT);
const STATE_FILE = new URL("data/discovery.json", ROOT);
const UA = "OpenSeatBot/1.0 (+https://github.com/lalapicoroso/open-seat)";
const BUDGET = Number(process.env.DISCOVER_BUDGET || 250);
const PAGES_PER_SOURCE = Number(process.env.DISCOVER_PAGES || 2);
const RECHECK_DAYS = 45; // una empresa descartada se vuelve a mirar después de este tiempo
const DEADLINE = Date.now() + Number(process.env.DISCOVER_MINUTES || 25) * 60_000;

// Qué buscar en el índice de Common Crawl para cada ATS
export const SOURCES = [
  { key: "lever", query: "url=jobs.lever.co/*" },
  { key: "ashby", query: "url=jobs.ashbyhq.com/*" },
  { key: "greenhouse-new", query: "url=job-boards.greenhouse.io/*" },
  { key: "greenhouse-old", query: "url=boards.greenhouse.io/*" },
  { key: "workable", query: "url=apply.workable.com/*" },
  { key: "recruitee", query: "url=recruitee.com&matchType=domain" },
  { key: "smartrecruiters", query: "url=jobs.smartrecruiters.com/*" },
];

// Direcciones que no son de una empresa
const NOT_A_COMPANY = new Set(["embed", "api", "v0", "v1", "jobs", "apply", "careers", "static", "assets", "favicon.ico", "robots.txt", "sitemap.xml", "www", "app", "help", "support", "blog", "login", "signup", "oauth", "careers-page", "job_app", "job-boards", "boards"]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const daysSince = d => (Date.now() - new Date(d)) / 864e5;

async function get(url, { json = true, timeout = 60000, tries = 3 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      if (res.status === 503 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return json ? await res.json() : await res.text();
    } catch (e) {
      if (e.fatal || i === tries) throw e;
      await sleep(5000 * i); // Common Crawl pide paciencia cuando está cargado
    } finally { clearTimeout(t); }
  }
}

// Saca { ats, slug } de cada línea del índice y cuenta cuántas veces aparece cada empresa
export function slugsFromIndex(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let url;
    try { url = JSON.parse(line).url; } catch { continue; }
    const d = detectATS(url);
    if (!d || NOT_A_COMPANY.has(d.slug.toLowerCase()) || d.slug.length < 2) continue;
    const key = `${d.ats}:${d.slug.toLowerCase()}`;
    const c = counts.get(key) || { ...d, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  return counts;
}

function prettyName(slug) {
  return slug.replace(/[-_.]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
}

export function isWorthAdding(jobs) {
  return jobs.some(j => j.ar === true);
}

async function main() {
  const companies = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));
  let state = { crawl: null, cursors: {}, checked: {} };
  try { state = { ...state, ...JSON.parse(await readFile(STATE_FILE, "utf8")) }; } catch {}

  // 1. El crawl más reciente
  const crawls = await get("https://index.commoncrawl.org/collinfo.json");
  const crawl = crawls[0];
  if (state.crawl !== crawl.id) { state.crawl = crawl.id; state.cursors = {}; }
  console.log(`Índice: ${crawl.id}`);

  const following = new Set(companies.companies.map(c => `${c.ats}:${c.slug.toLowerCase()}`));
  const candidates = new Map();

  // 2. Leer un tramo del índice de cada ATS
  for (const src of SOURCES) {
    if (Date.now() > DEADLINE) break;
    try {
      const base = `${crawl["cdx-api"]}?${src.query}&output=json&fl=url`;
      const info = await get(`${base}&showNumPages=true`);
      const total = info.pages || 0;
      let page = state.cursors[src.key] || 0;
      let read = 0;
      while (read < PAGES_PER_SOURCE && page < total && Date.now() < DEADLINE) {
        const text = await get(`${base}&page=${page}`, { json: false, timeout: 120000 });
        for (const [k, c] of slugsFromIndex(text)) {
          if (following.has(k)) continue;
          const prev = candidates.get(k);
          candidates.set(k, prev ? { ...prev, n: prev.n + c.n } : c);
        }
        page++; read++;
        await sleep(2000);
      }
      state.cursors[src.key] = page;
      console.log(`  ${src.key}: páginas ${page}/${total}`);
    } catch (e) {
      console.log(`  ${src.key}: no se pudo leer el índice (${e.message})`);
    }
  }

  // 3. Revisar las empresas nuevas, empezando por las que más aparecen
  const queue = [...candidates.entries()]
    .filter(([k]) => !state.checked[k] || daysSince(state.checked[k]) > RECHECK_DAYS)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, BUDGET);
  console.log(`\nEmpresas nuevas en este tramo: ${candidates.size}. Reviso ${queue.length}.`);

  const added = [];
  let checked = 0;
  for (const [key, c] of queue) {
    if (Date.now() > DEADLINE) { console.log("Se terminó el tiempo de esta corrida; sigue mañana."); break; }
    checked++;
    state.checked[key] = today();
    try {
      const jobs = await ATS_FETCHERS[c.ats]({ slug: c.slug, name: prettyName(c.slug) });
      if (isWorthAdding(jobs)) {
        const name = c.ats === "workable" || c.ats === "recruitee" || c.ats === "smartrecruiters"
          ? (jobs[0]?.c || prettyName(c.slug)) : prettyName(c.slug);
        companies.companies.push({ ats: c.ats, slug: c.slug, name, via: "discover", found: today() });
        following.add(key);
        const ar = jobs.filter(j => j.ar === true).length;
        added.push(`${name} (${c.ats}): ${ar} de ${jobs.length} avisos tomables desde Argentina`);
      }
    } catch { /* página vacía o inexistente: queda marcada como revisada */ }
    await sleep(c.ats === "lever" ? 1000 : 300);
  }

  // No dejar que la memoria crezca sin fin: olvidar revisiones muy viejas
  for (const [k, d] of Object.entries(state.checked)) if (daysSince(d) > 180) delete state.checked[k];

  await writeFile(COMPANIES_FILE, JSON.stringify(companies, null, 2) + "\n");
  await writeFile(STATE_FILE, JSON.stringify(state) + "\n");

  console.log(`\nRevisadas: ${checked}. Sumadas: ${added.length}.`);
  for (const line of added) console.log(`  + ${line}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
