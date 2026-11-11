# Open Seat

Portal de empleo para roles de diseño, UX/UI y producto, con foco en lo que se puede tomar desde Argentina y Latinoamérica.

- **Sitio:** página estática (`index.html`) publicada con GitHub Pages.
- **Avisos:** `data/jobs.json`, que GitHub Actions actualiza cada 6 horas con `scripts/ingest.mjs`.
- **Fuentes:** páginas de empleo de empresas en Greenhouse, Lever, Ashby, Workable, Recruitee y SmartRecruiters (`data/companies.json`), Get on Board y Remotive.

## Cómo funciona la actualización

1. El workflow **Actualizar avisos** (`.github/workflows/ingest.yml`) corre cada 6 horas.
2. Consulta cada fuente y se queda solo con roles de diseño, UX/UI, research, producto, desarrollo y datos.
3. Clasifica cada aviso: rol, seniority, modalidad, idioma y si se puede aplicar desde Argentina (sí / no / no lo aclara).
4. Si un aviso no aparece en su fuente durante 2 corridas seguidas, se da por cerrado y se elimina. Si una fuente falla, sus avisos se conservan hasta la próxima corrida.
5. Guarda `data/jobs.json` con un commit. GitHub Pages publica el cambio solo.

## Poner el sitio en marcha (una sola vez)

1. **Subir los archivos.** En el repo, entrá a **Add file → Upload files**, arrastrá todo el contenido de la carpeta y tocá **Commit changes**.
   En Mac, la carpeta `.github` está oculta: en Finder apretá `Cmd + Shift + .` para verla y que se suba también.
2. **Permitir que el workflow guarde cambios.** En **Settings → Actions → General**, sección **Workflow permissions**, elegí **Read and write permissions** y tocá **Save**.
3. **Activar GitHub Pages.** En **Settings → Pages**, en **Source** elegí **Deploy from a branch**, rama **main** y carpeta **/ (root)**. Tocá **Save**.
4. **Correr la primera actualización.** En la pestaña **Actions**, elegí **Actualizar avisos** y tocá **Run workflow**. Cuando termine (unos minutos), en el log vas a ver cuántos avisos trajo de cada fuente.
5. El sitio queda en `https://lalapicoroso.github.io/open-seat/`.

## Sumar empresas

Editá `data/companies.json` y agregá una línea por empresa:

```json
{ "ats": "greenhouse", "slug": "nombre-en-la-url", "name": "Nombre visible" }
```

El `slug` es la parte final de la URL de su página de empleos:

| ATS | URL de la página de empleos |
| --- | --- |
| greenhouse | `job-boards.greenhouse.io/<slug>` o `boards.greenhouse.io/<slug>` |
| lever | `jobs.lever.co/<slug>` |
| ashby | `jobs.ashbyhq.com/<slug>` |
| workable | `apply.workable.com/<slug>` |
| recruitee | `<slug>.recruitee.com` |
| smartrecruiters | `jobs.smartrecruiters.com/<slug>` |

Si un slug está mal, la corrida no se rompe: esa empresa aparece con ✗ en el log y se saltea.

## Probar en tu compu (opcional)

```bash
node scripts/ingest.mjs          # trae los avisos (necesita Node 20+)
python3 -m http.server 8000       # y abrí http://localhost:8000
```

## Reglas de las fuentes

- Siempre se linkea al aviso original; la postulación se hace ahí.
- Lever: se respeta el límite de 1 consulta por segundo.
- Remotive: como mucho 4 consultas por día y crédito visible en cada aviso (el sitio muestra la fuente).
- Get on Board: se usa su API pública de búsqueda. Si cambian el formato, hay que ajustar `fromGetOnBoard()` en `scripts/ingest.mjs`; el resto de las fuentes sigue funcionando igual.
- GitHub pausa los workflows programados de repos públicos tras 60 días sin actividad. Los commits de la actualización cuentan como actividad, pero conviene mirar la pestaña **Actions** de vez en cuando.
