// Open Seat — ingesta de avisos
// Corre en GitHub Actions (Node 20+). Sin dependencias externas.
// Uso: node scripts/ingest.mjs
//
// 1. Consulta cada fuente (ATS de empresas, Get on Board, Remotive).
// 2. Se queda solo con roles de diseño, UX y producto.
// 3. Clasifica rol, seniority, modalidad y si se puede aplicar desde Argentina.
// 4. Fusiona con data/jobs.json: los avisos que faltan en 2 corridas seguidas se dan por cerrados.

import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const JOBS_FILE = new URL("data/jobs.json", ROOT);
const COMPANIES_FILE = new URL("data/companies.json", ROOT);
const MISSES_TO_CLOSE = 2;
const UA = "OpenSeatBot/1.0 (+https://github.com/lalapicoroso/open-seat)";

// ---------- utilidades ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export function stripHTML(html = "") {
  return String(html)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function excerpt(text, max = 180) {
  const t = stripHTML(text);
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ---------- clasificación ----------
const RELEVANT = /(designer|diseñador|diseñadora|design lead|head of design|\bux\b|\bui\b|ux\/ui|ui\/ux|user research|(ux|user|design|product) researcher|investigador ux|product manager|product owner|product lead|head of product|director of product|vp,? product|group product|product analyst|product operations|product ops|content designer|ux writer|product marketing)/i;
const EXCLUDE = /(graphic designer|gr[aá]fico|motion designer|learning designer|game designer|level designer|sound designer|interior designer|fashion|hardware designer|chip designer|circuit|asic|fpga|mechanical|industrial designer|instructional designer)/i;

export function isRelevant(title) {
  return RELEVANT.test(title) && !EXCLUDE.test(title);
}

export function classifyRole(title) {
  const t = title.toLowerCase();
  if (/research|investigador/.test(t)) return "research";
  if (/product (manager|owner|lead|director)|head of product|director of product|vp,? product|group product/.test(t)) return "pm";
  if (/product (analyst|operations|ops|marketing)|ux writer|content designer/.test(t)) return "other";
  if (/product design|product designer|design lead|head of design/.test(t)) return "pd";
  if (/\bux\b|\bui\b|ux\/ui|ui\/ux|interaction|visual designer|web designer/.test(t)) return "uxui";
  if (/designer|diseñador|diseñadora/.test(t)) return "pd";
  return "other";
}

export function classifyLevel(title) {
  const t = title.toLowerCase();
  if (/\b(intern|internship|pasant|trainee|junior|jr\.?)\b/.test(t)) return "junior";
  if (/\b(staff|principal|lead|head of|director|vp)\b/.test(t)) return "lead";
  if (/\b(senior|sr\.?|ssr|semi ?senior)\b/.test(t)) return /semi|ssr/.test(t) ? "mid" : "senior";
  if (/\b(ii|mid|mid-level|semi)\b/.test(t)) return "mid";
  return "any";
}

const AR_YES = /(argentina|buenos aires|c[oó]rdoba|rosario|mendoza|latam|latin ?america|latinoam[eé]rica|south america|sudam[eé]rica|am[eé]rica latina|\bamericas\b|anywhere|worldwide|cualquier (lugar|pa[ií]s)|global(ly)?\b|fully remote.*world)/i;
const AR_NO = /(\bus\b|u\.s\.|usa|united states|estados unidos|canada|canad[aá]|\buk\b|united kingdom|england|ireland|london|europe|europa|emea|apac|asia|india|germany|deutschland|berlin|france|paris|spain|españa|madrid|barcelona|portugal|lisbon|italy|netherlands|amsterdam|poland|australia|new zealand|singapore|japan|tokyo|china|korea|philippines|indonesia|malaysia|vietnam|thailand|israel|uae|dubai|south africa|nigeria|kenya|brazil|brasil|m[eé]xico|mexico|chile|colombia|per[uú]|uruguay|paraguay|bolivia|ecuador|venezuela|costa rica|panam[aá]|guatemala|dominican|new york|nyc|san francisco|seattle|austin|boston|chicago|los angeles|bristol|toronto|vancouver|são paulo|sao paulo|bogot[aá]|medell[ií]n|santiago|lima|montevideo|office)/i;

// true = se puede aplicar desde Argentina · false = no · null = el aviso no lo aclara
export function classifyAR(location = "", description = "", mod = "") {
  const loc = location || "";
  if (AR_YES.test(loc)) return true;
  if (AR_NO.test(loc)) {
    // el aviso puede listar varias regiones: si la descripción nombra Argentina/LATAM, lo tomamos como válido
    if (/argentina|latam|latin america|latinoam/i.test(description.slice(0, 4000))) return true;
    return false;
  }
  if (/argentina|latam|latin america|latinoam[eé]rica|anywhere in the world|from anywhere/i.test(description.slice(0, 4000))) return true;
  if (mod === "Presencial" && loc) return false;
  return null;
}

export function classifyModality(...texts) {
  const s = texts.filter(Boolean).join(" ").toLowerCase();
  if (/hybrid|h[ií]brido/.test(s)) return "Híbrido";
  if (/remote|remoto|anywhere|teletrabajo|work from home/.test(s)) return "Remoto";
  return "Presencial";
}

export function detectLang(text = "") {
  const sample = ` ${stripHTML(text).slice(0, 1500).toLowerCase()} `;
  const es = (sample.match(/ (de|la|que|el|en|los|para|con|una|del|las|por) /g) || []).length;
  const en = (sample.match(/ (the|and|to|of|you|with|for|our|will|is|are|in) /g) || []).length;
  return es > en ? "Español" : "Inglés";
}

function typeOf(s = "") {
  s = s.toLowerCase();
  if (/freelance|contract|contractor|temporary|fixed[- ]term/.test(s)) return "Freelance";
  if (/part/.test(s)) return "Part time";
  return "Full time";
}

function build({ id, title, company, url, src, location, modHints = [], description = "", type = "", posted = null, salary = "" }) {
  const mod = classifyModality(location, title, ...modHints);
  const ar = classifyAR(location, description, mod);
  const tags = [];
  if (salary) tags.push(salary);
  return {
    id, t: title.trim(), c: company, url, src,
    role: classifyRole(title), lvl: classifyLevel(title), mod,
    reg: location || (mod === "Remoto" ? "Remoto" : "No especificado"),
    ar, type: typeOf(type), lang: detectLang(description || title),
    sum: excerpt(description), tags, posted,
  };
}

// ---------- fuentes ----------
async function fromGreenhouse({ slug, name }) {
  const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  return (data.jobs || []).filter(j => isRelevant(j.title)).map(j => build({
    id: `greenhouse:${slug}:${j.id}`, title: j.title, company: name, url: j.absolute_url, src: "Greenhouse",
    location: j.location?.name || "", description: j.content || "",
    posted: j.first_published || j.updated_at || null,
  }));
}

async function fromLever({ slug, name }) {
  const data = await getJSON(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  await sleep(1000); // Lever pide 1 consulta por segundo
  return (Array.isArray(data) ? data : []).filter(j => isRelevant(j.text)).map(j => build({
    id: `lever:${slug}:${j.id}`, title: j.text, company: name, url: j.hostedUrl, src: "Lever",
    location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", "),
    modHints: [j.workplaceType === "on-site" ? "" : j.workplaceType],
    description: j.descriptionPlain || j.description || "", type: j.categories?.commitment || "",
    posted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

async function fromAshby({ slug, name }) {
  const data = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
  return (data.jobs || []).filter(j => j.isListed !== false && isRelevant(j.title)).map(j => {
    const locs = [j.location, ...(j.secondaryLocations || []).map(l => l.location)].filter(Boolean);
    return build({
      id: `ashby:${slug}:${j.id}`, title: j.title, company: name, url: j.jobUrl, src: "Ashby",
      location: locs.join(", "),
      modHints: [j.isRemote ? "remote" : "", j.workplaceType || ""],
      description: j.descriptionPlain || j.descriptionHtml || "", type: j.employmentType || "",
      posted: j.publishedAt || null,
      salary: j.compensation?.compensationTierSummary || "",
    });
  });
}

// Remotive: sus condiciones piden no consultar más de 4 veces por día y dar crédito en cada aviso.
async function fromRemotive() {
  const out = [];
  for (const category of ["design", "product"]) {
    const data = await getJSON(`https://remotive.com/api/remote-jobs?category=${category}`);
    for (const j of data.jobs || []) {
      if (!isRelevant(j.title)) continue;
      out.push(build({
        id: `remotive:${j.id}`, title: j.title, company: j.company_name, url: j.url, src: "Remotive",
        location: j.candidate_required_location || "", modHints: ["remote"],
        description: j.description || "", type: j.job_type || "", posted: j.publication_date || null,
        salary: j.salary || "",
      }));
    }
  }
  return out;
}

// Get on Board: endpoint público de búsqueda (sin autenticación). Formato JSON:API.
// Si cambian el formato, ajustar esta función; el resto del proceso sigue funcionando.
async function fromGetOnBoard() {
  const seen = new Map();
  for (const query of ["product designer", "ux", "ui designer", "ux research", "product manager", "product owner"]) {
    let page = 1;
    while (page <= 3) {
      const url = `https://www.getonbrd.com/api/v0/search/jobs?query=${encodeURIComponent(query)}&per_page=100&page=${page}&expand=${encodeURIComponent('["company"]')}`;
      const data = await getJSON(url);
      const items = data.data || [];
      for (const it of items) {
        const a = it.attributes || {};
        const title = a.title || "";
        if (!title || !isRelevant(title) || seen.has(it.id)) continue;
        const company = a.company?.data?.attributes?.name || "Empresa en Get on Board";
        const countries = Array.isArray(a.countries) ? a.countries.join(", ") : "";
        const remoteHint = a.remote ? (a.remote_modality === "hybrid" ? "hybrid" : "remote") : (a.remote_modality || "");
        let location = countries;
        if (a.remote && a.remote_modality === "fully_remote" && !countries) location = "Cualquier país";
        seen.set(it.id, build({
          id: `getonbrd:${it.id}`, title, company, url: it.links?.public_url || `https://www.getonbrd.com/jobs/${it.id}`, src: "Get on Board",
          location, modHints: [remoteHint], description: [a.description, a.projects, a.functions].filter(Boolean).join(" "),
          type: a.modality?.data?.attributes?.name || "", posted: a.published_at ? new Date(a.published_at * 1000).toISOString() : null,
          salary: a.min_salary && a.max_salary ? `USD ${a.min_salary}–${a.max_salary}` : "",
        }));
      }
      if (items.length < 100) break;
      page++; await sleep(500);
    }
  }
  return [...seen.values()];
}

// ---------- duplicados ----------
// Algunas empresas publican el mismo puesto una vez por país. Los unimos en un solo aviso
// con todas las ubicaciones, y limitamos cuántos avisos puede aportar una sola empresa.
const MAX_PER_COMPANY = 25;
export function dedupe(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    const key = `${j.c}|${j.t}`.toLowerCase().replace(/\s+/g, " ").trim();
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...j, _regs: [j.reg], _ars: [j.ar], _mods: [j.mod] }); continue; }
    g._regs.push(j.reg); g._ars.push(j.ar); g._mods.push(j.mod);
    if (j.id < g.id) { g.id = j.id; g.url = j.url; }
  }
  const perCompany = new Map();
  const out = [];
  for (const g of groups.values()) {
    const regs = [...new Set(g._regs.flatMap(r => r.split(/,\s*/)).filter(Boolean))];
    const ar = g._ars.includes(true) ? true : g._ars.includes(null) ? null : false;
    const mod = g._mods.includes("Remoto") ? "Remoto" : g._mods.includes("Híbrido") ? "Híbrido" : g.mod;
    const { _regs, _ars, _mods, ...rest } = g;
    const reg = regs.length > 4 ? `${regs.slice(0, 4).join(", ")} y ${regs.length - 4} más` : regs.join(", ");
    const n = perCompany.get(g.c) || 0;
    if (n >= MAX_PER_COMPANY) continue;
    perCompany.set(g.c, n + 1);
    out.push({ ...rest, reg: reg || rest.reg, ar, mod });
  }
  return out;
}

// ---------- fusión con la corrida anterior ----------
export function merge(prevJobs, fresh, failedSourceKeys, now) {
  const prev = new Map(prevJobs.map(j => [j.id, j]));
  const out = [];
  const freshIds = new Set();
  for (const j of fresh) {
    if (freshIds.has(j.id)) continue;
    freshIds.add(j.id);
    const old = prev.get(j.id);
    out.push({ ...j, firstSeen: old?.firstSeen || now, lastSeen: now, misses: 0 });
  }
  for (const old of prevJobs) {
    if (freshIds.has(old.id)) continue;
    // Si la fuente falló en esta corrida, no lo contamos como faltante
    const key = sourceKey(old.id);
    if (failedSourceKeys.has(key)) { out.push(old); continue; }
    const misses = (old.misses || 0) + 1;
    if (misses < MISSES_TO_CLOSE) out.push({ ...old, misses });
  }
  return out;
}

export function sourceKey(id) {
  const [src, slug] = id.split(":");
  return ["greenhouse", "lever", "ashby"].includes(src) ? `${src}:${slug}` : src;
}

// ---------- main ----------
async function main() {
  const now = new Date().toISOString();
  const { companies } = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));
  let prev = { jobs: [] };
  try { prev = JSON.parse(await readFile(JOBS_FILE, "utf8")); } catch {}

  const tasks = [
    ...companies.map(co => ({ key: `${co.ats}:${co.slug}`, run: () => ({ greenhouse: fromGreenhouse, lever: fromLever, ashby: fromAshby })[co.ats](co) })),
    { key: "getonbrd", run: fromGetOnBoard },
    { key: "remotive", run: fromRemotive },
  ];

  const fresh = [], failed = new Set(), report = [];
  for (const task of tasks) {
    try {
      const jobs = await task.run();
      fresh.push(...jobs);
      report.push(`✓ ${task.key}: ${jobs.length}`);
    } catch (e) {
      failed.add(task.key);
      report.push(`✗ ${task.key}: ${e.message}`);
    }
  }

  const jobs = merge(prev.jobs || [], dedupe(fresh), failed, now)
    .sort((a, b) => (b.posted || b.firstSeen || "").localeCompare(a.posted || a.firstSeen || ""));

  const sources = [...new Set(jobs.map(j => j.src))].sort();
  await writeFile(JOBS_FILE, JSON.stringify({ updatedAt: now, count: jobs.length, sources, jobs }, null, 1) + "\n");

  console.log(report.join("\n"));
  console.log(`\nTotal: ${jobs.length} avisos (${fresh.length} vistos en esta corrida, ${failed.size} fuentes con error).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
