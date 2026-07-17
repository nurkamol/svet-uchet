// Тесты расчётного ядра: извлекаем блок между маркерами из ../index.html
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const core = html
  .split('/* ============ ЯДРО РАСЧЁТОВ ============ */')[1]
  .split('/* ============ /ЯДРО ============ */')[0];
const api = new Function(core +
  '; return {analyze, blockCost, blockBreakdown, parseNum, parseDate, translateStatus, normStatus,' +
  ' monthLabel, monthNames, MONTHS, DEFAULT_TARIFF, findCols, rowsFromCols, extractRows,' +
  ' implausibleDays, MAX_PLAUSIBLE_KWH_PER_DAY, compareMonths,' +
  ' monthsFromReadings, analyzeManual, encodeShare, decodeShare};')();

let failed = 0;
function eq(name, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) failed++;
}

// --- парсинг чисел и дат
eq('parseNum запятая',        api.parseNum('1 234,56'), 1234.56);
eq('parseNum число',          api.parseNum(15.5), 15.5);
eq('parseDate dd/mm/yyyy',    api.parseDate('03/11/2025 00:00:00').getMonth(), 10);
eq('parseDate yyyy-mm-dd',    api.parseDate('2026-07-16').getDate(), 16);

// --- статусы
eq('status null → пусто',     api.translateStatus('null'), '');
eq('status NaN → пусто',      api.translateStatus('NaN'), '');
eq('status перевод',          api.translateStatus('[Phase Sequence Reversal]'), 'Обратный порядок фаз');

// --- локализация: без lang всё остаётся русским, с lang — переводится
eq('status uz латиница',      api.translateStatus('[Phase Sequence Reversal]', 'uz'), 'Fazalar tartibi teskari');
eq('status uz кириллица',     api.translateStatus('[Phase Sequence Reversal]', 'uzc'), 'Фазалар тартиби тескари');
eq('status uz: питание',      api.translateStatus('[Power Failure]', 'uz'), 'Ta’minot uzilishi');
eq('status uz: null → пусто', api.translateStatus('null', 'uz'), '');
eq('status: язык неизвестен → ru', api.translateStatus('[Cover Open]', 'de'), 'Вскрытие крышки');
eq('normStatus чистит null',  api.normStatus(' NULL '), '');
eq('normStatus не трогает',   api.normStatus('[Cover Open]'), '[Cover Open]');

eq('monthLabel по умолчанию ru', api.monthLabel(2026, 1, undefined), 'Февраль 2026');
eq('monthLabel uz латиница',     api.monthLabel(2026, 1, 'uz'), 'Fevral 2026');
eq('monthLabel uz кириллица',    api.monthLabel(2026, 1, 'uzc'), 'Феврал 2026');
eq('monthLabel: язык неизвестен → ru', api.monthLabel(2026, 0, 'de'), 'Январь 2026');
eq('во всех языках 12 месяцев',
   Object.keys(api.MONTHS).map(l=>api.monthNames(l).length), [12,12,12]);

// --- блочный тариф (эталоны сверены с Excel)
const T = api.DEFAULT_TARIFF;
eq('блоки: 119.27',  api.blockCost(119.27, T), 77526);
eq('блоки: 391.06',  api.blockCost(391.06, T), 301954);
eq('блоки: 12000',   api.blockCost(12000, T),
   200*650 + 300*900 + 500*1100 + 4000*1600 + 5000*1900 + 2000*2200);
eq('блоки: 0',       api.blockCost(0, T), 0);

// --- анализ: месячная агрегация накопительных показаний
const rows = [];
let a = 100;
for (let d = new Date(2026,0,30); d <= new Date(2026,2,2); d.setDate(d.getDate()+1)){
  rows.push({date: new Date(d), a, status: d < new Date(2026,1,5) ? '[Phase Sequence Reversal]' : 'null'});
  a += 10; // ровно 10 кВт·ч в сутки
}
const A = api.analyze(rows);
eq('месяцев найдено', A.months.length, 3);
eq('февраль = 28×10', Math.round(A.months[1].kwh), 280);
eq('февраль полный',  A.months[1].partial, false);
eq('январь неполный', A.months[0].partial, true);
eq('статус один и закрыт', A.statuses.length === 1 && !!A.statuses[0].to, true);
// статус хранится сырым — язык выбирается при отрисовке, файл не перечитывается
eq('статус хранится сырым', A.statuses[0].raw, '[Phase Sequence Reversal]');
eq('статус можно перевести позже',
   api.translateStatus(A.statuses[0].raw, 'uz'), 'Fazalar tartibi teskari');
eq('месяц называется на любом языке',
   [api.monthLabel(A.months[1].y, A.months[1].m, 'ru'), api.monthLabel(A.months[1].y, A.months[1].m, 'uz')],
   ['Февраль 2026', 'Fevral 2026']);

// --- ошибки: ядро отдаёт код, текст подбирает интерфейс
let code = '';
try { api.analyze([{date:new Date(2026,0,1), a:100, status:''}]); } catch(e){ code = e.message; }
eq('мало строк → код ошибки', code, 'E_TOO_FEW_ROWS');

// --- demo.csv парсится
// raw:true обязателен: иначе SheetJS типизирует ячейки сам и портит выгрузку —
// «108,59» → 10859, «02/01/2026» → mm/dd → 1 февраля. Так же читает index.html.
const XLSX = require('xlsx');
const wb = XLSX.readFile(path.join(__dirname, '..', 'samples', 'demo.csv'), {raw:true});
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:true});
const parsed = [];
for (let i=1;i<grid.length;i++){
  const r = grid[i]||[];
  const date = api.parseDate(r[1]); const v = api.parseNum(r[3]);
  if (date && isFinite(v)) parsed.push({date, a:v, status:r[2]});
}
const D = api.analyze(parsed);
eq('demo.csv: 74 суточных дельты', D.daily.length, 74);
eq('demo.csv: расход положительный', D.daily.every(x=>x.kwh>=0), true);

// Ячейки читаются как есть, без самодеятельности SheetJS
eq('demo.csv: запятая — дробная часть', parsed[1].a, 108.59);
eq('demo.csv: дата dd/mm, а не mm/dd', [parsed[1].date.getDate(), parsed[1].date.getMonth()], [2, 0]);
eq('demo.csv: первое и последнее показание', [parsed[0].a, parsed[parsed.length-1].a], [100, 805]);

// Эталон по demo.csv: расход месяца = показание 1-го числа след. месяца − 1-го числа этого.
// Январь 407,20−100,00; февраль 677,08−407,20; март (по 15-е) 805,00−677,08.
eq('demo.csv: январь', +D.months[0].kwh.toFixed(2), 307.20);
eq('demo.csv: февраль', +D.months[1].kwh.toFixed(2), 269.88);
eq('demo.csv: март (неполный)', +D.months[2].kwh.toFixed(2), 127.92);
eq('demo.csv: всего = 805−100', +D.daily.reduce((s,d)=>s+d.kwh,0).toFixed(2), 705.00);
eq('demo.csv: март неполный, февраль полный', [D.months[2].partial, D.months[1].partial], [true, false]);
// оплата января: 200×650 + 107,2×900
eq('demo.csv: январь к оплате', api.blockCost(D.months[0].kwh, T), 200*650 + Math.round(107.2*900));

const ymd = d => [d.getFullYear(), d.getMonth()+1, d.getDate()];

// --- ручной ввод показаний по месяцам
// показание на 1-е число = итог прошлого месяца; расход месяца = разница соседних
const rd = api.monthsFromReadings([
  {y:2026, m:0, a:100},   // 1 января
  {y:2026, m:1, a:400},   // 1 февраля → январь = 300
  {y:2026, m:2, a:600},   // 1 марта   → февраль = 200
]);
eq('вручную: два месяца из трёх показаний', rd.months.map(x=>[x.m, x.kwh]), [[0,300],[1,200]]);
eq('вручную: месяцы полные, а не «неполные»', rd.months.map(x=>x.partial), [false, false]);
eq('вручную: дней в месяце проставлено', rd.months.map(x=>x.daysInMonth), [31, 28]);
eq('вручную: январь к оплате', api.blockCost(rd.months[0].kwh, T), 200*650 + 100*900);

// показания в перепутанном порядке — сортируем сами
eq('вручную: порядок ввода не важен',
   api.monthsFromReadings([{y:2026,m:1,a:400},{y:2026,m:0,a:100}]).months.map(x=>[x.m, x.kwh]), [[0,300]]);
// через год
eq('вручную: декабрь → январь следующего года',
   api.monthsFromReadings([{y:2025,m:11,a:100},{y:2026,m:0,a:150}]).months.map(x=>[x.y,x.m,x.kwh]), [[2025,11,50]]);

// Пропуск месяца: дельта покрывает два месяца, разделить её нечем — не выдумываем
const gap = api.monthsFromReadings([{y:2026,m:0,a:100},{y:2026,m:2,a:700},{y:2026,m:3,a:800}]);
eq('вручную: месяц с пропуском выпадает', gap.months.map(x=>x.m), [2]);
eq('вручную: о пропуске сообщаем', gap.skipped.map(s=>[s.m, s.gap]), [[0, 2]]);

let mErr = '';
try { api.monthsFromReadings([{y:2026,m:0,a:100}]); } catch(e){ mErr = e.message; }
eq('вручную: одно показание → код ошибки', mErr, 'E_TOO_FEW_READINGS');
mErr = '';
try { api.monthsFromReadings([{y:2026,m:0,a:100},{y:2026,m:5,a:900}]); } catch(e){ mErr = e.message; }
eq('вручную: нет соседних месяцев → код ошибки', mErr, 'E_NO_MONTH_PAIRS');

// analyzeManual отдаёт структуру того же вида, что analyze
const AM = api.analyzeManual([{y:2026,m:0,a:100},{y:2026,m:1,a:400},{y:2026,m:2,a:600}]);
eq('вручную: суточных данных нет — и не выдумано', AM.daily, []);
eq('вручную: помечено как ручной ввод', AM.manual, true);
eq('вручную: первое и последнее показание', [AM.firstA, AM.lastA], [100, 600]);
eq('вручную: аномальных дней не ищем на пустом', api.implausibleDays(AM.daily).length, 0);
eq('вручную: последний месяц не «текущий неполный»', AM.months[AM.months.length-1].partial, false);
// счётчик не крутится назад: отрицательную дельту гасим в ноль, как и в analyze
eq('вручную: показание уменьшилось → 0, а не минус',
   api.monthsFromReadings([{y:2026,m:0,a:500},{y:2026,m:1,a:400}]).months[0].kwh, 0);

// --- сравнение двух выгрузок
const mo = (y, m, kwh) => ({y, m, kwh, days:30, daysInMonth:30, partial:false});
// Пики пересекают границу блока (200) — иначе нелинейность тарифа не проявится:
// 2025: январь 100, февраль 400 | 2026: январь 250, февраль 250. Сумма кВт·ч одна — 500.
const y2025 = [mo(2025,0,100), mo(2025,1,400)];
const y2026 = [mo(2026,0,250), mo(2026,1,250)];

const cy = api.compareMonths(y2025, y2026, 'year', T);
eq('год к году: пары по номеру месяца', cy.rows.map(r=>[r.a.y, r.b.y, r.a.m]), [[2025,2026,0],[2025,2026,1]]);
eq('год к году: январь +150', cy.rows[0].dKwh, 150);
eq('год к году: февраль −150', cy.rows[1].dKwh, -150);
eq('год к году: январь +150%', cy.rows[0].pct, 150);
eq('год к году: февраль −37,5%', cy.rows[1].pct, -37.5);
eq('год к году: итог по кВт·ч не изменился', [cy.kwhA, cy.kwhB, cy.dKwh], [500, 500, 0]);
eq('год к году: сумма считается по блокам каждого месяца',
   [cy.costA, cy.costB], [api.blockCost(100,T)+api.blockCost(400,T), api.blockCost(250,T)*2]);
// Тариф блочный и помесячный: те же 500 кВт·ч за год, но разложенные ровнее, дешевле —
// пик в 400 кВт·ч залезает во второй блок. Ровно это сравнение и должно показывать.
eq('год к году: ровный расход дешевле при той же сумме кВт·ч', cy.dCost < 0, true);
eq('год к году: экономия 25 000 сум', cy.dCost, -25000);

// «по порядку» сопоставляет по позиции, а не по месяцу
const co = api.compareMonths(y2025, [mo(2026,5,150), mo(2026,6,150)], 'order', T);
eq('по порядку: пары по позиции', co.rows.map(r=>[r.a.m, r.b.m]), [[0,5],[1,6]]);
eq('по порядку: длина = min', api.compareMonths(y2025, [mo(2026,5,150)], 'order', T).rows.length, 1);

// год к году: месяцы без пары выбрасываются — неполная пара соврала бы
const cp = api.compareMonths([mo(2025,0,100), mo(2025,7,300)], [mo(2026,0,150)], 'year', T);
eq('год к году: только общие месяцы', cp.rows.length, 1);
eq('год к году: итог только по общим', [cp.kwhA, cp.kwhB], [100, 150]);
eq('нет общих месяцев → пусто', api.compareMonths([mo(2025,0,100)], [mo(2026,5,150)], 'year', T).rows.length, 0);

// деление на ноль: месяц без расхода не должен давать Infinity
const cz = api.compareMonths([mo(2025,0,0)], [mo(2026,0,50)], 'year', T);
eq('процент от нуля → null, а не Infinity', cz.rows[0].pct, null);
eq('но дельта в кВт·ч считается', cz.rows[0].dKwh, 50);
eq('итоговый процент от нуля → null', cz.pct, null);

// --- ссылка-шэринг: в неё едут только итоги по месяцам и тарифы
// Значения взяты как из настоящего расчёта — с дробями, а не заранее округлённые:
// на круглых числах расхождение из-за округления в ссылке не проявится.
const shareMonths = [mo(2026,0,307.20000000000005), mo(2026,1,269.88000000000005), mo(2026,2,127.92000000000007)];
const enc = api.encodeShare(shareMonths, T);
const dec = api.decodeShare(enc);
eq('ссылка: месяцы вернулись', dec.months.map(x=>[x.y, x.m, x.kwh]), [[2026,0,307.2],[2026,1,269.88],[2026,2,127.92]]);
// Главное свойство: получатель обязан увидеть ровно ту же сумму, что и отправитель.
const итогОтправителя = shareMonths.reduce((s,m)=>s+api.blockCost(m.kwh, T), 0);
const итогПолучателя  = dec.months.reduce((s,m)=>s+api.blockCost(m.kwh, dec.tariff), 0);
eq('ссылка: итог у получателя совпадает до сума', итогПолучателя, итогОтправителя);
eq('ссылка: тариф вернулся', dec.tariff.map(b=>b.price), T.map(b=>b.price));
eq('ссылка: границы блоков берутся свои, а не из ссылки', dec.tariff.map(b=>b.upto), T.map(b=>b.upto));
eq('ссылка: месяцы полные', dec.months.every(x=>!x.partial), true);
eq('ссылка: оплата января совпадает', api.blockCost(dec.months[0].kwh, dec.tariff), api.blockCost(307.2, T));
// изменённый тариф уезжает вместе с данными: иначе у получателя другие цифры
const T2 = T.map((b,i)=>({...b, price: b.price + i*100}));
eq('ссылка: правленый тариф сохраняется',
   api.decodeShare(api.encodeShare(shareMonths, T2)).tariff.map(b=>b.price), T2.map(b=>b.price));

// битая ссылка обязана падать, а не притворяться валидной
const bad = s => { try { api.decodeShare(s); return 'не упало'; } catch(e){ return e.message; } };
const TP = T.map(b=>b.price).join('_');
eq('ссылка: пустая',            bad(''), 'E_SHARE_BAD');
eq('ссылка: чужая версия',      bad('v2~2026_0_100~'+TP), 'E_SHARE_BAD');
eq('ссылка: нет тарифа',        bad('v1~2026_0_100'), 'E_SHARE_BAD');
eq('ссылка: месяц 13',          bad('v1~2026_12_100~'+TP), 'E_SHARE_BAD');
eq('ссылка: отрицательный расход', bad('v1~2026_0_-5~'+TP), 'E_SHARE_BAD');
eq('ссылка: не число',          bad('v1~2026_0_abc~'+TP), 'E_SHARE_BAD');
eq('ссылка: мало полей в месяце', bad('v1~2026_0~'+TP), 'E_SHARE_BAD');
eq('ссылка: лишнее поле в месяце', bad('v1~2026_0_100_7~'+TP), 'E_SHARE_BAD');
eq('ссылка: мало цен в тарифе', bad('v1~2026_0_100~650_900'), 'E_SHARE_BAD');
eq('ссылка: месяцев нет',       bad('v1~~'+TP), 'E_SHARE_BAD');
eq('ссылка: мусор',             bad('привет'), 'E_SHARE_BAD');
eq('ссылка: null',              bad(null), 'E_SHARE_BAD');
// в ссылке не должно быть ничего лишнего
eq('ссылка: без суточных данных и имён', /^v1~[\d._!-]+~[\d_]+$/.test(enc), true);
eq('ссылка: короткая', enc.length < 120, true);
eq('ссылка: безопасна для URL', encodeURIComponent(enc) === enc, true);

// --- разбор колонок: фазы ни при чём, нужны только дата и +A
const HEAD3 = ['NO.','Clock','Meter internal status','Active energy import (+A)(kWh)'];
eq('EX518: колонки найдены',
   (({dateCol,aCol,stCol,hi}) => [hi,dateCol,aCol,stCol])(api.findCols([HEAD3])), [0,1,3,2]);

// однофазный EX18: тот же вендор и та же программа считывания → те же заголовки,
// но статуса «обратный порядок фаз» на одной фазе не бывает, колонки статуса может не быть
const HEAD1 = ['NO.','Clock','Active energy import (+A)(kWh)'];
eq('EX18: колонки найдены без статуса',
   (({dateCol,aCol,stCol}) => [dateCol,aCol,stCol])(api.findCols([HEAD1])), [1,2,-1]);
const ex18 = api.extractRows([HEAD1,
  ['1','01/01/2026 00:00:00','100,0'], ['2','02/01/2026 00:00:00','108,59'], ['3','03/01/2026 00:00:00','119,8']]);
eq('EX18: строки разобраны', ex18.map(r=>r.a), [100, 108.59, 119.8]);
eq('EX18: пустой статус не ломает', ex18.every(r=>r.status===''), true);
eq('EX18: расход считается', +api.analyze(ex18).daily.reduce((s,d)=>s+d.kwh,0).toFixed(2), 19.80);

// зоны Т1–Т4 не должны подменять общий +A
eq('колонка rate не путается с +A',
   api.findCols([['Clock','Active energy import (+A) rate 1 (kWh)','Active energy import (+A)(kWh)']]).aCol, 2);
eq('заголовков нет → null', api.findCols([['1','2','3'],['4','5','6']]), null);
eq('узбекский заголовок Sana', api.findCols([['NO.','Sana','Active energy import (+A)(kWh)']]).dateCol, 1);

// ручное сопоставление: пользователь сам указал колонки, заголовок отсеется сам
const oddGrid = [['дата снятия','прочее','показания'],
  ['01/01/2026','x','100,0'], ['02/01/2026','x','110,5'], ['03/01/2026','x','121,0']];
eq('колонки не опознаны', api.findCols(oddGrid), null);
const manual = api.rowsFromCols(oddGrid, 0, 2, -1, 0);
eq('вручную: заголовок отсеян', manual.length, 3);
eq('вручную: значения верны', manual.map(r=>r.a), [100, 110.5, 121]);
eq('вручную: неверная пара колонок → пусто', api.rowsFromCols(oddGrid, 1, 1, -1, 0).length, 0);

// --- проверка правдоподобия: ловит неверно прочитанный файл
const day = (n, kwh) => ({date:new Date(2026,0,n), kwh});
eq('нормальный расход — молчим', api.implausibleDays([day(1, 12), day(2, 30), day(3, 150)]).length, 0);
eq('порог не срабатывает на границе', api.implausibleDays([day(1, api.MAX_PLAUSIBLE_KWH_PER_DAY)]).length, 0);
eq('баг с запятой был бы пойман', api.implausibleDays([day(1, 12), day(2, 5219.64)]).map(d=>d.kwh), [5219.64]);
// порог выше физического потолка EX18 (60 A × 220 В ≈ 13 кВт ≈ 317 кВт·ч/сут)
eq('порог с запасом над EX18', api.MAX_PLAUSIBLE_KWH_PER_DAY > 317, true);

// --- .xlsx: raw:true не должен ломать настоящий Excel (там ячейки уже типизированы)
const wsX = XLSX.utils.aoa_to_sheet([
  ['NO.','Clock','Meter internal status','Active energy import (+A)(kWh)'],
  [1, 46023, 'null', 100],
  [2, 46024, 'null', 108.59],
  [3, 46025, 'null', 119.8],
], {cellDates:false});
const wbX = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wbX, wsX, 'S');
const gridX = XLSX.utils.sheet_to_json(
  XLSX.read(XLSX.write(wbX, {type:'array', bookType:'xlsx'}), {type:'array', raw:true}).Sheets.S,
  {header:1, raw:true});
const px = [];
for (let i=1;i<gridX.length;i++){
  const d = api.parseDate(gridX[i][1]), v = api.parseNum(gridX[i][3]);
  if (d && isFinite(v)) px.push({date:d, a:v, status:gridX[i][2]});
}
eq('.xlsx: числа остались числами', px.map(r=>r.a), [100, 108.59, 119.8]);
eq('.xlsx: серийные даты разобраны', px.map(r=>ymd(r.date)), [[2026,1,1], [2026,1,2], [2026,1,3]]);
eq('.xlsx: расход считается', +api.analyze(px).daily.reduce((s,d)=>s+d.kwh,0).toFixed(2), 19.80);

// --- .xls (BIFF8, Excel 97–2003): работает за счёт полной сборки SheetJS.
// Если xlsx.full.min.js в index.html заменят на облегчённую сборку — этот тест упадёт.
const xlsBuf = XLSX.write(wbX, {type:'array', bookType:'biff8'});
eq('.xls: это OLE2-контейнер, а не zip',
   [...new Uint8Array(xlsBuf).slice(0,4)], [0xd0, 0xcf, 0x11, 0xe0]);
const gridXls = XLSX.utils.sheet_to_json(
  XLSX.read(xlsBuf, {type:'array', raw:true}).Sheets.S, {header:1, raw:true});
const pxls = api.rowsFromCols(gridXls, api.findCols(gridXls).dateCol, api.findCols(gridXls).aCol, -1, 1);
eq('.xls: значения разобраны', pxls.map(r=>r.a), [100, 108.59, 119.8]);
eq('.xls: расход считается', +api.analyze(pxls).daily.reduce((s,d)=>s+d.kwh,0).toFixed(2), 19.80);

// серийная дата Excel (46054 = 01.02.2026): числом (.xlsx) и строкой (.csv без типизации)
eq('серийная дата числом', ymd(api.parseDate(46054)), [2026, 2, 1]);
eq('серийная дата строкой', ymd(api.parseDate('46054.000127')), [2026, 2, 1]);
eq('серийная дата: запятая в дробной', ymd(api.parseDate('46054,000127')), [2026, 2, 1]);
eq('не дата → null', api.parseDate('какой-то текст'), null);

console.log(failed ? `\n${failed} тест(ов) упало` : '\nВсе тесты прошли');
process.exit(failed ? 1 : 0);
