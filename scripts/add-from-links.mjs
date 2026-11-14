// Open Seat — suma empresas a partir de links a avisos
// Lo corre .github/workflows/add-from-links.yml. Sirve para aprovechar listas curadas
// (newsletters, posts) que linkean a avisos originales: de cada link sacamos la página de
// empleos de la empresa y, si está en un sistema que leemos, la revisamos.
//
// Se suma solo si tiene al menos un aviso de diseño, producto, desarrollo o datos que se pueda
// tomar desde Argentina (el mismo criterio que el descubrimiento automático).
//
// Uso local: LINKS="https://jobs.ashbyhq.com/empresa/123 https://job-boards.greenhouse.io/otra/jobs/1" node scripts/add-from-links.mjs

import { readFile, writeFile } from "node:fs/promises";
import { ATS_FETCHERS, detectATS } from "./ingest.mjs";

const COMPANIES_FILE = new URL("../data/companies.json", import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DESIGN = new Set(["pd", "uxui", "research"]);
const pretty = s => s.replace(/\.[a-z]{2}$/, "").replace(/[-_.]+/g, " ").replace(/-\d+$/, "").replace(/\b\w/g, c => c.toUpperCase()).trim();

async function main() {
  const links = String(process.env.LINKS || "").split(/[\s,]+/).filter(s => /^https?:\/\//.test(s));
  const data = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));
  const key = c => `${c.ats}:${c.slug.toLowerCase()}`;
  const following = new Set(data.companies.map(key));
  const via = String(process.env.VIA || "links").slice(0, 40);

  const boards = new Map();
  let unreadable = 0;
  for (const l of links) { const d = detectATS(l); if (!d) { unreadable++; continue; } boards.set(key(d), d); }
  const already = [...boards.keys()].filter(k => following.has(k));
  const todo = [...boards.values()].filter(d => !following.has(key(d)));
  console.log(`${links.length} links → ${boards.size} empresas en sistemas que leemos (${unreadable} links de otros sistemas). Ya seguidas: ${already.length}. A revisar: ${todo.length}.\n`);

  const added = [], noAR = [], failed = [];
  for (const d of todo) {
    try {
      const jobs = await ATS_FETCHERS[d.ats]({ slug: d.slug, name: pretty(d.slug) });
      const ar = jobs.filter(j => j.ar === true);
      const design = ar.filter(j => DESIGN.has(j.role)).length;
      const name = jobs[0]?.c && !/^[a-z0-9-]+$/.test(jobs[0].c) ? jobs[0].c : pretty(d.slug);
      if (ar.length) {
        data.companies.push({ ats: d.ats, slug: d.slug, name, via, found: new Date().toISOString().slice(0, 10) });
        following.add(key(d));
        added.push(`${name} (${d.ats}): ${ar.length} de ${jobs.length} tomables desde Argentina, ${design} de diseño`);
      } else noAR.push(`${name} (${jobs.length} avisos)`);
    } catch (e) { failed.push(`${d.ats}/${d.slug}: ${e.message}`); }
    await sleep(d.ats === "lever" ? 1000 : 300);
  }
  await writeFile(COMPANIES_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(`Sumadas (${added.length}):\n  ${added.join("\n  ")}\n`);
  console.log(`Sin avisos tomables desde Argentina (${noAR.length}): ${noAR.join(", ")}\n`);
  if (failed.length) console.log(`No se pudieron leer (${failed.length}): ${failed.join("; ")}`);
}
main();
