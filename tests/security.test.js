// Проверки безопасности, которые можно сделать статически, без браузера.
// Ловят то, что легко разъезжается при правках: CSP в двух местах, отсутствие внешних
// ресурсов (всё вендорнуто в /assets), экранирование ввода пользователя.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const headers = fs.readFileSync(path.join(root, '_headers'), 'utf8');

let failed = 0;
function eq(name, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) failed++;
}

/* ---- CSP: политика продублирована в meta и в _headers, они обязаны совпадать ---- */
const norm = csp => Object.fromEntries(csp.split(';').map(p => p.trim().split(/\s+/))
  .filter(b => b[0]).map(b => [b[0], b.slice(1).sort().join(' ')]));

const meta = norm(html.match(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)"\s*>/)[1]);
const hdr  = norm(headers.split('Content-Security-Policy:')[1].split('\n')[0]);

eq('CSP: meta и _headers совпадают', meta, hdr);

// Директивы, ради которых всё затевалось
eq('CSP: отправка данных запрещена',   meta['connect-src'], "'none'");
eq('CSP: по умолчанию всё запрещено',  meta['default-src'], "'none'");
eq('CSP: картинки только свои и data:', meta['img-src'], "'self' data:");
eq('CSP: формы никуда не отправить',   meta['form-action'], "'none'");
eq('CSP: <base> не подменить',         meta['base-uri'], "'none'");
eq('CSP: сайт не встроить в iframe',   meta['frame-ancestors'], "'none'");
eq('CSP: eval не разрешён', /unsafe-eval/.test(JSON.stringify(meta)), false);

// Всё вендорнуто: ни в одной директиве не должно быть внешних адресов
for (const d of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src']){
  eq(`CSP: в ${d} нет внешних адресов`, /https?:/.test(meta[d] || ''), false);
}
eq('CSP: скрипты только свои', meta['script-src'], "'self' 'unsafe-inline'");
eq('CSP: стили только свои',   meta['style-src'], "'self' 'unsafe-inline'");
eq('CSP: шрифты только свои',  meta['font-src'], "'self'");

/* ---- Никаких внешних ресурсов: всё в /assets, сайт автономен ----
   Именно из-за внешнего Google Fonts прод один раз сломался (Cloudflare Fonts). */
const внешниеСсылки = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(https?:\/\/[^"]+)"[^>]*>/g)]
  .map(m => m[1])
  .filter(u => !/rel="(?:canonical|alternate)"/.test(html.slice(Math.max(0, html.indexOf(u)-80), html.indexOf(u)+u.length+20)));
eq('нет внешних script/link (кроме canonical/hreflang)', внешниеСсылки, []);
eq('шрифты подключены локально', /href="\/assets\/fonts\.css"/.test(html), true);
eq('библиотеки подключены локально',
   /src="\/assets\/lib\/xlsx[^"]*"/.test(html) && /src="\/assets\/lib\/chart[^"]*"/.test(html), true);

/* ---- вендорнутые файлы реально лежат на диске ---- */
for (const f of ['assets/fonts.css', 'assets/lib/xlsx.full.min.js', 'assets/lib/chart.umd.min.js',
                 'assets/fonts/dseg7classic-regular.woff2']){
  eq('файл на месте: ' + f, fs.existsSync(path.join(root, f)), true);
}
// каждый @font-face в fonts.css указывает на существующий woff2
const fontsCss = fs.readFileSync(path.join(root, 'assets/fonts.css'), 'utf8');
const woff2 = [...fontsCss.matchAll(/url\('\/assets\/fonts\/([^']+)'\)/g)].map(m => m[1]);
const пропавшие = woff2.filter(n => !fs.existsSync(path.join(root, 'assets/fonts', n)));
eq('все шрифты из fonts.css существуют (' + woff2.length + ')', пропавшие, []);

/* ---- экранирование: содержимое файла пользователя не должно попадать в разметку сырым ---- */
const ui = html.split('/* ============ /ЯДРО ============ */')[1];
eq('XSS: ячейки превью экранируются', /html \+= '<td>'\+esc\(/.test(ui), true);
eq('XSS: статус счётчика экранируется', /esc\(translateStatus\(/.test(ui), true);
eq('XSS: esc покрывает опасные символы',
   ["&", "<", ">", '"', "'"].every(c => ui.includes(`'${c}'`) || ui.includes(`"${c}"`)), true);

console.log(failed ? `\n${failed} тест(ов) упало` : '\nВсе проверки безопасности прошли');
process.exit(failed ? 1 : 0);
