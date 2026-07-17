// Проверки безопасности, которые можно сделать статически, без браузера.
// Ловят то, что легко разъезжается при правках: SRI-хеши, CSP в двух местах, экранирование.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

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
// Утечь можно и через картинку, и через форму — поэтому внешних адресов там быть не должно
eq('CSP: в img-src нет внешних адресов',  /https?:/.test(meta['img-src']), false);
eq('CSP: в connect-src нет внешних адресов', /https?:/.test(meta['connect-src']), false);
eq('CSP: eval не разрешён', /unsafe-eval/.test(JSON.stringify(meta)), false);

/* ---- SRI: у всех внешних скриптов и стилей должен быть integrity ----
   Исключение — Google Fonts: их CSS отдаётся разным разным браузерам, и фиксированный
   хеш сломал бы шрифты. Это осознанное решение, а не забывчивость. */
const внешние = [...html.matchAll(/<(script|link)\b[^>]*?(?:src|href)="(https:\/\/[^"]+)"[^>]*>/g)]
  .map(m => ({tag: m[0], url: m[2]}))
  .filter(x => !/rel="(preconnect|icon|apple-touch-icon|manifest|canonical|alternate)"/.test(x.tag));

for (const {tag, url} of внешние){
  const google = url.startsWith('https://fonts.googleapis.com');
  const есть = /integrity="sha384-/.test(tag);
  if (google) eq('SRI: Google Fonts намеренно без integrity', есть, false);
  else {
    eq('SRI: есть integrity — ' + url.split('/').pop(), есть, true);
    eq('SRI: есть crossorigin — ' + url.split('/').pop(), /crossorigin=/.test(tag), true);
  }
}

/* ---- экранирование: содержимое файла пользователя не должно попадать в разметку сырым ---- */
const ui = html.split('/* ============ /ЯДРО ============ */')[1];
eq('XSS: ячейки превью экранируются', /html \+= '<td>'\+esc\(/.test(ui), true);
eq('XSS: статус счётчика экранируется', /esc\(translateStatus\(/.test(ui), true);
eq('XSS: esc покрывает опасные символы',
   ["&", "<", ">", '"', "'"].every(c => ui.includes(`'${c}'`) || ui.includes(`"${c}"`)), true);

/* ---- SRI-хеши обязаны соответствовать тому, что реально лежит на CDN ----
   Иначе после смены версии библиотеки приложение молча перестанет грузиться. */
const скачать = url => new Promise((res, rej) => {
  https.get(url, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location)
      return скачать(r.headers.location).then(res, rej);
    if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode));
    const chunks = []; r.on('data', c => chunks.push(c));
    r.on('end', () => res(Buffer.concat(chunks)));
  }).on('error', rej);
});

(async () => {
  for (const {tag, url} of внешние){
    const m = tag.match(/integrity="sha384-([^"]+)"/);
    if (!m) continue;
    try {
      const buf = await скачать(url);
      const real = crypto.createHash('sha384').update(buf).digest('base64');
      eq('SRI: хеш сходится с CDN — ' + url.split('/').pop(), real, m[1]);
    } catch (e) {
      console.log('  -- пропуск (сеть недоступна): ' + url.split('/').pop() + ' — ' + e.message);
    }
  }
  console.log(failed ? `\n${failed} тест(ов) упало` : '\nВсе проверки безопасности прошли');
  process.exit(failed ? 1 : 0);
})();
