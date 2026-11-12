// Open Seat — procesa una sugerencia de empresa (un issue de GitHub)
// Lo corre .github/workflows/suggest.yml cuando alguien abre un issue "Sumar empresa: ...".
//
// 1. Busca en el texto del issue el link a la página de empleos.
// 2. Reconoce el ATS (Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters).
// 3. Prueba leer sus avisos. Si funciona, la suma a data/companies.json.
// 4. Escribe el resultado en $RUNNER_TEMP/suggest-result.json para que el workflow
//    comente en el issue y lo cierre (o lo deje abierto si hace falta revisarlo a mano).

import { readFile, writeFile } from "node:fs/promises";
import { detectATS, ATS_FETCHERS } from "./ingest.mjs";

const COMPANIES_FILE = new URL("../data/companies.json", import.meta.url);
const OUT = `${process.env.RUNNER_TEMP || "/tmp"}/suggest-result.json`;

const LABEL = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workable: "Workable", recruitee: "Recruitee", smartrecruiters: "SmartRecruiters" };

async function done(result) {
  await writeFile(OUT, JSON.stringify(result));
  console.log(result.comment);
}

function field(body, label) {
  // Lee un campo del formulario del issue: "### Etiqueta\n\nvalor"
  const m = body.match(new RegExp(`###\\s*${label}\\s*\\n+([^\\n#][^\\n]*)`, "i"));
  const v = m ? m[1].trim() : "";
  return v === "_No response_" ? "" : v;
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const body = String(event.issue?.body || "");
  const urls = body.match(/https?:\/\/[^\s)>\]"']+/g) || [];
  const found = urls.map(detectATS).find(Boolean);
  const givenName = field(body, "Nombre de la empresa").slice(0, 80);

  if (!found) {
    return done({ close: false, comment:
      "¡Gracias por la sugerencia! 🙌\n\nNo reconocí el link como una página de empleos que Open Seat pueda leer automáticamente. " +
      "Por ahora funcionan: Greenhouse, Lever, Ashby, Workable, Recruitee y SmartRecruiters.\n\n" +
      "Dejo la sugerencia abierta para revisarla a mano." });
  }

  const { ats, slug } = found;
  const data = JSON.parse(await readFile(COMPANIES_FILE, "utf8"));
  const exists = data.companies.find(c => c.ats === ats && c.slug.toLowerCase() === slug.toLowerCase());
  if (exists) {
    return done({ close: true, comment: `¡Gracias! **${exists.name}** (${LABEL[ats]}) ya está en Open Seat. Sus avisos se actualizan cada 6 horas.` });
  }

  let jobs;
  try {
    jobs = await ATS_FETCHERS[ats]({ slug, name: givenName || slug });
  } catch (e) {
    return done({ close: false, comment:
      `¡Gracias por la sugerencia! Reconocí una página de ${LABEL[ats]} (\`${slug}\`), pero no pude leer sus avisos (${e.message}). ` +
      "Puede que el link esté mal o que la empresa ya no use esa página. Dejo la sugerencia abierta para revisarla a mano." });
  }

  const name = givenName || jobs[0]?.c || slug;
  data.companies.push({ ats, slug, name });
  await writeFile(COMPANIES_FILE, JSON.stringify(data, null, 2) + "\n");

  const ar = jobs.filter(j => j.ar === true).length;
  const lines = [
    `¡Listo, sumé **${name}** a Open Seat! 🎉`,
    "",
    jobs.length
      ? `Hoy tiene **${jobs.length}** ${jobs.length === 1 ? "aviso" : "avisos"} de diseño, producto, desarrollo o datos${ar ? `, ${ar} de ellos abiertos a Argentina o LATAM` : ""}. Van a aparecer en el sitio con la próxima actualización (cada 6 horas).`
      : "Hoy no tiene avisos de diseño, producto, desarrollo o datos, pero la vamos a seguir mirando y van a aparecer cuando publique.",
    "",
    "Gracias por ayudar a que haya más lugares para la comunidad 💛",
  ];
  return done({ close: true, added: { ats, slug, name }, comment: lines.join("\n") });
}

main().catch(async e => {
  console.error(e);
  await done({ close: false, comment: "Hubo un error procesando la sugerencia. La dejo abierta para revisarla a mano." });
});
