// Open Seat — busca la página de empleos de empresas a partir de sus nombres
// Lo corre .github/workflows/find-boards.yml con una lista de nombres separados por coma o renglón.
//
// Para cada nombre prueba las direcciones más probables en Greenhouse, Lever, Ashby, Workable,
// Recruitee y SmartRecruiters (por ejemplo "Emi Labs" → emilabs, emi-labs). Si encuentra una
// página con avisos de diseño, producto, desarrollo o datos, la suma a data/companies.json.
//
// Uso local: NAMES="Emi Labs, Tiendanube" node scripts/find-boards.mjs

import { readFile, writeFile } from "node:fs/promises";
import { ATS_FETCHERS } from "./ingest.mjs";

const COMPANIES_FILE = new URL("../data/companies.json", import.meta.url);
const ORDER = ["greenhouse", "lever", "ashby", "workable", "recruitee", "smartrecruiters"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// "Emi Labs" → [{slug:"emilabs"}, {slug:"emi-labs"}, {slug:"emi", loose:true}]
// Las variantes "loose" sacan una palabra (Labs, AI, App…): son más arriesgadas,
// así que solo se aceptan si la página tiene avisos tomables desde Argentina.
export function slugVariants(name) {
  const clean = name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.(com|io|ai|app|co|art|net|org)(\.ar)?$/i, m => " " + m.slice(1))
    .replace(/\b(s\.?r\.?l\.?|s\.?a\.?|inc\.?|llc|ltd)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const out = [];
  const add = (slug, loose = false) => { if (slug.length >= 2 && !out.some(v => v.slug === slug)) out.push({ slug, loose }); };
  add(words.join(""));
  if (words.length > 1) add(words.join("-"));
  const SUFFIX = new Set(["ai", "labs", "lab", "app", "hq", "com", "io", "tech", "digital", "group", "resources"]);
  if (words.length > 1 && SUFFIX.has(words.at(-1))) {
    const core = words.slice(0, -1);
    add(core.join(""), true);
    if (core.length > 1) add(core.join("-"), true);
  }
  return out;
}

export async function findBoard(name) {
  for (const { slug, loose } of slugVariants(name)) {
    for (const ats of ORDER) {
      try {
        const jobs = await ATS_FETCHERS[ats]({ slug, name });
        const ar = jobs.filter(j => j.ar === true).length;
        if (!jobs.length) continue;
        if (loose && !ar) continue;
        return { ats, slug, jobs: jobs.length, ar };
      } catch { /* no existe en este ATS */ }
      if (ats === "lever") await sleep(1000);
    }
  }
  return null;
}

async function main() {
  const names = String(process.env.NAMES || "").split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (!names.length) { console.log("No hay nombres para buscar."); return; }
  const data = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));
  const key = c => `${c.ats}:${c.slug.toLowerCase()}`;
  const following = new Set(data.companies.map(key));
  const followingNames = new Set(data.companies.map(c => c.name.toLowerCase()));

  const found = [], skipped = [], missing = [];
  for (const name of [...new Set(names)]) {
    if (followingNames.has(name.toLowerCase())) { skipped.push(name); continue; }
    const hit = await findBoard(name);
    if (!hit) { missing.push(name); continue; }
    if (following.has(key(hit))) { skipped.push(name); continue; }
    data.companies.push({ ats: hit.ats, slug: hit.slug, name, via: "find-boards", found: new Date().toISOString().slice(0, 10) });
    following.add(key(hit));
    found.push(`${name} → ${hit.ats}/${hit.slug} (${hit.jobs} avisos, ${hit.ar} tomables desde Argentina)`);
  }
  await writeFile(COMPANIES_FILE, JSON.stringify(data, null, 2) + "\n");

  console.log(`Sumadas (${found.length}):`); found.forEach(l => console.log(`  + ${l}`));
  console.log(`Ya estaban (${skipped.length}): ${skipped.join(", ") || "-"}`);
  console.log(`Sin página en estos ATS o sin avisos relevantes (${missing.length}): ${missing.join(", ") || "-"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
