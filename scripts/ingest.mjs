// Open Seat — ingesta de avisos
// Corre en GitHub Actions (Node 20+). Sin dependencias externas.
// Uso: node scripts/ingest.mjs
//
// 1. Consulta cada fuente (ATS de empresas: Greenhouse, Lever, Ashby, Workable, Recruitee y SmartRecruiters; Get on Board; Remotive; Findjobit; Remote OK; We Work Remotely; Jobicy).
// 2. Se queda solo con roles de diseño, UX, producto, desarrollo y datos.
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

async function getJSON(url, { timeout = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function getText(url, { timeout = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
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
const RELEVANT_DESIGN = /(designer|diseñador|diseñadora|design lead|head of design|\bux\b|\bui\b|ux\/ui|ui\/ux|user research|(ux|user|design|product) researcher|investigador ux|content designer|ux writer)/i;
const RELEVANT_PRODUCT = /(product manager|product owner|product lead|head of product|director of product|vp,? product|group product|product analyst|product operations|product ops|product marketing)/i;
const RELEVANT_DEV = /(software engineer|software developer|developer|desarrollador|desarrolladora|programador|frontend|front-end|front end|backend|back-end|back end|full ?stack|full-stack|mobile engineer|ios engineer|android engineer|\bios\b|\bandroid\b|react|node\.?js|devops|\bsre\b|site reliability|platform engineer|infrastructure engineer|cloud engineer|qa engineer|\bqa\b|quality assurance|test automation|tester|engineering manager|tech lead|staff engineer|principal engineer|product engineer|design engineer|security engineer)/i;
const RELEVANT_DATA = /(data engineer|data scientist|data analyst|analytics engineer|machine learning|\bml\b|ml engineer|ai engineer|\bllm\b|científico de datos|ingeniero de datos|analista de datos|business intelligence|\bbi\b)/i;
const RELEVANT = new RegExp([RELEVANT_DESIGN, RELEVANT_PRODUCT, RELEVANT_DEV, RELEVANT_DATA].map(r => r.source).join("|"), "i");
const EXCLUDE = /(translat|traduc|locali[sz]ation|linguist|interpreter|review lead|proofread|transcri|cabinet|kitchen|furniture|architectural|\bcad\b|drafter|drafting|landscape|jewel|textile|packaging designer|print designer|graphic designer|gr[aá]fico|motion designer|learning designer|game designer|level designer|sound designer|interior designer|fashion|hardware|chip designer|circuit|asic|fpga|mechanical|electrical engineer|civil engineer|industrial designer|instructional designer|sales engineer|field engineer|recruiter|account executive)/i;

export function isRelevant(title) {
  return RELEVANT.test(title) && !EXCLUDE.test(title);
}

export function classifyRole(title) {
  const t = title.toLowerCase();
  if (/designer|diseñador/.test(t) && /(brand|creative|multimedia|market|motion|animat|presentation|social media|\bads?\b|static|digital designer)/.test(t)) return "other";
  if (/(ux|user|design|product) research|researcher|investigador/.test(t) && !RELEVANT_DATA.test(t)) return "research";
  if (/product (manager|owner|lead|director)|head of product|director of product|vp,? product|group product/.test(t)) return "pm";
  if (RELEVANT_DATA.test(t)) return "data";
  if (RELEVANT_DEV.test(t) && !/designer|diseñador/.test(t)) return "dev";
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
  // Francés y portugués comparten palabras con el español: se cuentan aparte para no confundirlos
  const fr = (sample.match(/ (le|les|et|des|du|vous|nous|est|avec|une|sur|au|aux|être|dans) /g) || []).length;
  const pt = (sample.match(/ (não|você|com|são|também|está|nós|seu|sua|ao|às|é|uma|pelo|pela) /g) || []).length;
  const best = Math.max(es, en, fr, pt);
  if (best === en) return "Inglés";
  if (best === fr) return "Francés";
  if (best === pt) return "Portugués";
  return "Español";
}

function typeOf(s = "") {
  s = s.toLowerCase();
  if (/freelance|contract|contractor|temporary|fixed[- ]term/.test(s)) return "Freelance";
  if (/part/.test(s)) return "Part time";
  return "Full time";
}

// Saca códigos internos del final del título: "Senior Product Designer (PCS946)", "Designer | LATAM Only | 85137"
export function cleanTitle(t = "") {
  return t.replace(/\s*[|\-–]\s*\d{4,}\s*$/, "").replace(/\s*\(([A-Z]{2,5}\d{2,6}|\d{4,})\)\s*$/, "").replace(/\s{2,}/g, " ").trim();
}

function build({ id, title: rawTitle, company, url, src, location, modHints = [], description = "", type = "", posted = null, salary = "" }) {
  const title = cleanTitle(rawTitle);
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
export async function fromGreenhouse({ slug, name }) {
  const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  return (data.jobs || []).filter(j => isRelevant(j.title)).map(j => build({
    id: `greenhouse:${slug}:${j.id}`, title: j.title, company: name, url: j.absolute_url, src: "Greenhouse",
    location: j.location?.name || "", description: j.content || "",
    posted: j.first_published || j.updated_at || null,
  }));
}

export async function fromLever({ slug, name }) {
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

export async function fromAshby({ slug, name }) {
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

export async function fromWorkable({ slug, name }) {
  const data = await getJSON(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
  return (data.jobs || []).filter(j => isRelevant(j.title)).map(j => {
    const locs = (j.locations && j.locations.length ? j.locations : [j]).map(l => [l.city, l.country].filter(Boolean).join(", ")).filter(Boolean);
    return build({
      id: `workable:${slug}:${j.shortcode}`, title: j.title, company: data.name || name, url: j.url || j.shortlink || `https://apply.workable.com/${slug}/j/${j.shortcode}/`, src: "Workable",
      location: [...new Set(locs)].join("; "), modHints: [j.telecommuting ? "remote" : ""],
      description: j.description || "", type: j.employment_type || "", posted: j.published_on || j.created_at || null,
    });
  });
}

export async function fromRecruitee({ slug, name }) {
  const data = await getJSON(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`);
  return (data.offers || []).filter(j => isRelevant(j.title)).map(j => {
    const locs = (j.locations && j.locations.length ? j.locations : [j]).map(l => [l.city, l.country].filter(Boolean).join(", ")).filter(Boolean);
    return build({
      id: `recruitee:${slug}:${j.id}`, title: j.title, company: j.company_name || name, url: j.careers_url, src: "Recruitee",
      location: [...new Set(locs)].join("; ") || j.location || "", modHints: [j.remote ? "remote" : "", j.hybrid ? "hybrid" : ""],
      description: j.description || "", type: j.employment_type_code || "", posted: j.published_at || null,
    });
  });
}

const COUNTRY = { ar: "Argentina", br: "Brasil", mx: "México", co: "Colombia", cl: "Chile", pe: "Perú", uy: "Uruguay", us: "United States", es: "Spain", gb: "United Kingdom", ca: "Canada" };
export async function fromSmartRecruiters({ slug, name }) {
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const data = await getJSON(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=${offset}`);
    const items = data.content || [];
    for (const j of items) {
      if (!isRelevant(j.name)) continue;
      const l = j.location || {};
      const loc = l.fullLocation || [l.city, COUNTRY[(l.country || "").toLowerCase()] || l.country].filter(Boolean).join(", ");
      out.push(build({
        id: `smartrecruiters:${slug}:${j.id}`, title: j.name, company: j.company?.name || name, url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, src: "SmartRecruiters",
        location: loc, modHints: [l.remote ? "remote" : "", l.hybrid ? "hybrid" : ""],
        type: j.typeOfEmployment?.label || "", posted: j.releasedDate || null,
      }));
    }
    if (items.length < 100) break;
    await sleep(300);
  }
  return out;
}

// Findjobit: feed RSS público. Piden atribuir la fuente, así que el sitio muestra "vía Findjobit"
// y siempre linkea al aviso original. Solo guardamos un extracto corto de la descripción.
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}
export function parseFindjobit(xml) {
  const out = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/gi) || []) {
    const rawTitle = stripHTML(xmlTag(block, "title"));
    const link = stripHTML(xmlTag(block, "link")) || stripHTML(xmlTag(block, "guid"));
    if (!rawTitle || !link) continue;
    // "Niuro busca un Senior Frontend Engineer (React) · Remote LATAM"
    const m = rawTitle.match(/^(.*?)\s+busca\s+(?:un|una|un\/a|uno)?\s*(.+)$/i);
    const company = m ? m[1].trim() : "Empresa en Findjobit";
    const title = (m ? m[2] : rawTitle).replace(/\s+[·|]\s+(remote|remoto|latam|híbrido|hibrido)[^·|]*$/i, "").trim();
    const region = stripHTML(xmlTag(block, "region"));
    const description = xmlTag(block, "description");
    const pub = xmlTag(block, "pubDate");
    const id = (link.match(/jobs\/([a-f0-9]{12,})/i) || [])[1] || link;
    out.push({ id, rawTitle, title, company, link, region, description, type: stripHTML(xmlTag(block, "type")), posted: pub ? new Date(pub).toISOString() : null });
  }
  return out;
}
export async function fromFindjobit() {
  const xml = await getText("https://findjobit.com/jobs/feed");
  return parseFindjobit(xml).filter(j => isRelevant(j.title)).map(j => {
    const job = build({
      id: `findjobit:${j.id}`, title: j.title, company: j.company, url: j.link, src: "Findjobit",
      location: j.region, modHints: [j.rawTitle, stripHTML(j.description).slice(0, 600)],
      description: j.description, type: j.type, posted: j.posted,
    });
    // La región de Findjobit es la lista exacta de países habilitados: manda sobre la descripción.
    if (j.region) job.ar = /argentina/i.test(j.region);
    return job;
  });
}

// Remote OK: API pública (remoteok.com/api). Sus condiciones piden linkear al aviso en Remote OK
// con un link normal (sin nofollow) y nombrarlos como fuente: el sitio muestra "vía Remote OK".
export async function fromRemoteOK() {
  const data = await getJSON("https://remoteok.com/api");
  return (Array.isArray(data) ? data : []).filter(j => j && j.position && j.url).filter(j => isRelevant(j.position)).map(j => build({
    id: `remoteok:${j.id || j.slug}`, title: j.position, company: j.company || "Empresa en Remote OK", url: j.url, src: "Remote OK",
    location: j.location || "", modHints: ["remote"],
    description: j.description || "", posted: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : null),
    salary: j.salary_min && j.salary_max ? `USD ${Math.round(j.salary_min / 1000)}k–${Math.round(j.salary_max / 1000)}k/año` : "",
  }));
}

// We Work Remotely: RSS público por categoría. Piden atribuir los links a We Work Remotely.
const WWR_FEEDS = ["remote-design-jobs", "remote-product-jobs", "remote-front-end-programming-jobs", "remote-back-end-programming-jobs", "remote-full-stack-programming-jobs", "remote-devops-sysadmin-jobs"];
export function parseWWR(xml) {
  const out = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/gi) || []) {
    const raw = stripHTML(xmlTag(block, "title"));
    const link = stripHTML(xmlTag(block, "link")) || stripHTML(xmlTag(block, "guid"));
    if (!raw || !link) continue;
    const i = raw.indexOf(": ");
    out.push({
      company: i > 0 ? raw.slice(0, i).trim() : "Empresa en We Work Remotely",
      title: (i > 0 ? raw.slice(i + 2) : raw).trim(),
      link, region: [stripHTML(xmlTag(block, "region")), stripHTML(xmlTag(block, "country"))].filter(Boolean).join(", "),
      type: stripHTML(xmlTag(block, "type")), description: xmlTag(block, "description"), pub: xmlTag(block, "pubDate"),
    });
  }
  return out;
}
export async function fromWWR() {
  const seen = new Map();
  for (const feed of WWR_FEEDS) {
    const xml = await getText(`https://weworkremotely.com/categories/${feed}.rss`);
    for (const j of parseWWR(xml)) {
      if (seen.has(j.link) || !isRelevant(j.title)) continue;
      seen.set(j.link, build({
        id: `wwr:${j.link.replace(/^.*\/remote-jobs\//, "")}`, title: j.title, company: j.company, url: j.link, src: "We Work Remotely",
        location: j.region, modHints: ["remote"], description: j.description, type: j.type,
        posted: j.pub ? new Date(j.pub).toISOString() : null,
      }));
    }
    await sleep(800);
  }
  return [...seen.values()];
}

// Jobicy: API pública. Piden no consultar más de una vez por hora (nosotros: cada 6 horas)
// y mantener el link al aviso y la atribución: el sitio muestra "vía Jobicy".
export async function fromJobicy() {
  const seen = new Map();
  let ok = 0, lastError = null;
  // Una sola pasada por corrida (piden no sincronizar más de una vez por hora).
  for (const q of ["count=100&geo=latam", "count=100&industry=design-multimedia", "count=100&tag=designer", "count=100&tag=product", "count=100&industry=engineering", "count=100&industry=data-science"]) {
    try {
      const data = await getJSON(`https://jobicy.com/api/jobs?${q}`);
      ok++;
      for (const j of data.jobs || []) {
        if (!j.jobTitle || !j.url || seen.has(j.id) || !isRelevant(j.jobTitle)) continue;
        seen.set(j.id, build({
          id: `jobicy:${j.id}`, title: j.jobTitle,
          company: j.companyName || "Empresa en Jobicy", url: j.url, src: "Jobicy",
          location: j.jobGeo || "", modHints: ["remote"], description: j.jobDescription || j.jobExcerpt || "",
          type: Array.isArray(j.jobType) ? j.jobType.join(" ") : (j.jobType || ""), posted: j.pubDate ? (() => { const d = new Date(/T|Z|\+/.test(j.pubDate) ? j.pubDate : j.pubDate.replace(" ", "T") + "Z"); return isNaN(d) ? null : d.toISOString(); })() : null,
          salary: (j.salaryMin || j.annualSalaryMin) && (j.salaryMax || j.annualSalaryMax)
            ? `${j.salaryCurrency || "USD"} ${Math.round((j.salaryMin || j.annualSalaryMin) / 1000)}k–${Math.round((j.salaryMax || j.annualSalaryMax) / 1000)}k${/month/i.test(j.salaryPeriod || "") ? "/mes" : "/año"}` : "",
        }));
      }
    } catch (e) { lastError = e; }
    await sleep(1500);
  }
  if (!ok) throw lastError || new Error("sin resultados");
  return [...seen.values()];
}

// Remotive: sus condiciones piden no consultar más de 4 veces por día y dar crédito en cada aviso.
async function fromRemotive() {
  const out = [];
  for (const category of ["design", "product", "software-dev", "data", "devops", "qa"]) {
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
  const queries = ["product designer", "ux", "ui designer", "ux research", "diseñador", "diseño ux", "ux writer", "design system", "investigador ux", "product manager", "product owner", "frontend", "backend", "fullstack", "mobile", "devops", "qa", "data engineer", "data scientist", "machine learning"];
  let ok = 0, lastError = null;
  for (const query of queries) {
    try {
      for (let page = 1; page <= 3; page++) {
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
        await sleep(1500); // pausa entre consultas para no saturar la API
        if (items.length < 100) break;
      }
      ok++;
    } catch (e) {
      lastError = e;
      if (/HTTP (403|429)/.test(e.message)) { await sleep(10000); }
    }
  }
  if (!ok) throw lastError || new Error("sin resultados");
  if (lastError) console.log(`  getonbrd: ${queries.length - ok} búsquedas fallaron (${lastError.message}); se usan las demás.`);
  return [...seen.values()];
}

export const ATS_FETCHERS = { greenhouse: fromGreenhouse, lever: fromLever, ashby: fromAshby, workable: fromWorkable, recruitee: fromRecruitee, smartrecruiters: fromSmartRecruiters };

// Reconoce la página de empleos de una empresa y devuelve { ats, slug }, o null.
export function detectATS(raw = "") {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const first = (u.pathname.split("/").filter(Boolean)[0] || "");
  const ok = s => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s) ? s : null;
  if (/(^|\.)greenhouse\.io$/.test(host)) { const q = u.searchParams.get("for"); const slug = ok(q || first); return slug && slug !== "embed" ? { ats: "greenhouse", slug } : null; }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return ok(first) ? { ats: "lever", slug: first } : null;
  if (host === "jobs.ashbyhq.com") return ok(first) ? { ats: "ashby", slug: decodeURIComponent(first) } : null;
  if (host === "apply.workable.com") return ok(first) ? { ats: "workable", slug: first } : null;
  if (host.endsWith(".workable.com") && host !== "jobs.workable.com") return { ats: "workable", slug: host.split(".")[0] };
  if (host.endsWith(".recruitee.com")) return ok(host.split(".")[0]) ? { ats: "recruitee", slug: host.split(".")[0] } : null;
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") return ok(first) ? { ats: "smartrecruiters", slug: first } : null;
  return null;
}

// ---------- duplicados ----------
// Algunas empresas publican el mismo puesto una vez por país. Los unimos en un solo aviso
// con todas las ubicaciones, y limitamos cuántos avisos puede aportar una sola empresa.
const MAX_PER_COMPANY = 40;
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
  return ["greenhouse", "lever", "ashby", "workable", "recruitee", "smartrecruiters"].includes(src) ? `${src}:${slug}` : src;
}

// ---------- main ----------
async function main() {
  const now = new Date().toISOString();
  const { companies } = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));
  let prev = { jobs: [] };
  try { prev = JSON.parse(await readFile(JOBS_FILE, "utf8")); } catch {}

  const tasks = [
    ...companies.map(co => ({ key: `${co.ats}:${co.slug}`, run: () => ATS_FETCHERS[co.ats](co) })),
    { key: "getonbrd", run: fromGetOnBoard },
    { key: "remotive", run: fromRemotive },
    { key: "findjobit", run: fromFindjobit },
    { key: "remoteok", run: fromRemoteOK },
    { key: "wwr", run: fromWWR },
    { key: "jobicy", run: fromJobicy },
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
