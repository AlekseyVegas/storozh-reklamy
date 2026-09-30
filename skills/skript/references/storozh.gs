/**
 * СТОРОЖ РЕКЛАМЫ — ежедневный отчёт по рекламе из Google Таблицы в Телеграм.
 *
 * Что делает: раз в сутки находит в таблице строку за отчётный день,
 * сравнивает CTR, CPC и CPL каждого направления с порогами и присылает
 * в Телеграм короткий отчёт. Всё в порядке — одна строка «Норма».
 *
 * Где хранится токен бота: в свойствах скрипта, а не в коде.
 * Задаётся через меню «Сторож рекламы» — «Настроить Телеграм»
 * или вручную: Настройки проекта — Свойства скрипта.
 *
 * Куда уходят данные: только в Телеграм, в указанный вами чат
 * (api.telegram.org). Больше никуда.
 */

// ============================ НАСТРОЙКИ ============================

const CONFIG = {
  // Лист с данными. Пусто — берётся первый лист таблицы.
  SHEET_NAME: '',

  // Строка с названиями направлений и строка с названиями метрик.
  ROW_DIRECTIONS: 1,
  ROW_METRICS: 2,

  // За какой день отчёт: 1 — за вчера, 0 — за сегодня.
  REPORT_DAY_OFFSET: 1,

  // Во сколько присылать отчёт: час по часовому поясу таблицы.
  // Google запускает в течение этого часа: 11 — между 11:00 и 12:00.
  SEND_HOUR: 10,

  // Пороги по умолчанию для всех направлений.
  THRESHOLDS: {
    CTR_MIN: 0.004,   // CTR не ниже 0,4%
    CPC_MAX: 300,     // CPC не выше 300 ₽
    CPL_MAX: 1000,    // CPL не выше 1000 ₽
    CPL_WINDOW_DAYS: 1, // CPL и «лидов 0» — за 1 день (отчётный)
  },

  // Свои пороги для отдельных направлений (название — точно как в строке 1).
  // Пример: 'Лендинг А': { CPL_MAX: 1500, CTR_MIN: 0.006 },
  // null — не проверять эту метрику у направления: { CPL_MAX: null }.
  // CPL_WINDOW_DAYS — за сколько последних дней считать CPL и «лидов 0».
  // Для направлений с 1–3 лидами в день ставьте 3–7, иначе тревоги будут через день.
  THRESHOLDS_BY_DIRECTION: {
  },

  // Порог значимости: на маленьких объёмах метрики не судим.
  MIN_IMPRESSIONS_FOR_CTR: 300,  // CTR проверяем от 300 показов
  MIN_CLICKS_FOR_CPC: 5,         // CPC проверяем от 5 кликов
  // «Бюджет есть, лидов ноль» — тревога, если за окно CPL потрачено не меньше этого.
  ZERO_LEADS_MIN_BUDGET: 1000,

  // Направления, которые сознательно не проверяем (название — как в строке 1).
  // Они всё равно перечисляются в конце отчёта, чтобы не выпасть молча.
  SKIP_DIRECTIONS: [],

  // Название отчёта в заголовке сообщения.
  REPORT_TITLE: 'Сторож рекламы',
};

// ======================= ДАЛЬШЕ МОЖНО НЕ ТРОГАТЬ =======================

const METRIC_NAMES = {
  budget: ['бюджет'],
  impressions: ['показы', 'показов'],
  clicks: ['клики', 'кликов', 'переходы'],
  leads: ['лиды', 'лидов', 'заявки', 'конверсии'],
};

/** Меню в таблице. Появляется при открытии таблицы. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Сторож рекламы')
    .addItem('1. Настроить Телеграм', 'setupTelegram')
    .addItem('2. Проверить разметку', 'checkLayout')
    .addItem('3. Дозаполнить даты', 'fillDates')
    .addItem('4. Тестовый отчёт (без отправки)', 'testReport')
    .addItem('5. Отправить отчёт сейчас', 'dailyReport')
    .addItem('6. Включить ежедневный отчёт', 'enableDailyTrigger')
    .addToUi();
}

// ---------------------------- Главное ----------------------------

/** Ежедневный отчёт. Эту функцию запускает триггер. */
function dailyReport() {
  try {
    const date = reportDate_();
    const text = buildReport_(date);
    sendTelegram_(text);
    Logger.log(text);
  } catch (e) {
    const msg = '⚠️ ' + escapeHtml_(CONFIG.REPORT_TITLE) + ': отчёт не посчитался.\n' +
      escapeHtml_(String(e && e.message ? e.message : e));
    Logger.log(msg);
    try { sendTelegram_(msg); } catch (e2) { Logger.log('Телеграм недоступен: ' + e2); }
  }
}

/** Отчёт в журнал без отправки. Дата: из диалога или отчётный день. */
function testReport() {
  let date = reportDate_();
  const ui = tryUi_();
  if (ui) {
    const tz = tz_();
    const answer = ui.prompt('Тестовый отчёт',
      'Дата в формате дд.мм.гггг (пусто — ' + Utilities.formatDate(date, tz, 'dd.MM.yyyy') + '):',
      ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    const typed = answer.getResponseText().trim();
    if (typed) {
      const parsed = parseDate_(typed);
      if (!parsed) { ui.alert('Не понял дату: ' + typed); return; }
      date = parsed;
    }
  }
  const text = buildReport_(date);
  Logger.log(text);
  if (ui) ui.alert('Отчёт (в Телеграм не отправлен)', stripHtml_(text), ui.ButtonSet.OK);
  return text;
}

/** Показывает, какие направления и колонки нашёл скрипт. */
function checkLayout() {
  const sheet = getSheet_();
  const layout = readLayout_(sheet);
  const lines = ['Лист: ' + sheet.getName()];
  layout.directions.forEach(function (d) {
    lines.push('✅ ' + d.name + ': бюджет ' + colLetter_(d.cols.budget) +
      ', показы ' + colLetter_(d.cols.impressions) +
      ', клики ' + colLetter_(d.cols.clicks) +
      ', лиды ' + colLetter_(d.cols.leads) +
      (isSkipped_(d.name) ? ' (в списке SKIP_DIRECTIONS — не проверяется)' : ''));
    if (!isSkipped_(d.name)) lines.push('   пороги: ' + describeThresholds_(thresholdsFor_(d.name)) +
      (CONFIG.THRESHOLDS_BY_DIRECTION[d.name] ? ' (свои)' : ' (общие)'));
  });
  unknownKeys_(layout).forEach(function (k) {
    lines.push('⚠️ В настройках есть «' + k + '», но такого направления нет в строке ' +
      CONFIG.ROW_DIRECTIONS + '. Проверьте написание: пробелы, слэш в конце, латиница и кириллица.');
  });
  layout.broken.forEach(function (b) {
    lines.push('❌ ' + b.name + ': ' + b.reason);
  });
  if (!layout.directions.length && !layout.broken.length) {
    lines.push('Не нашёл ни одного направления. В строке ' + CONFIG.ROW_METRICS +
      ' у каждого направления должна быть колонка «Бюджет».');
  }
  lines.push('Строк с датами: ' + readDateRows_(sheet).length);
  const text = lines.join('\n');
  Logger.log(text);
  const ui = tryUi_();
  if (ui) ui.alert('Разметка', text, ui.ButtonSet.OK);
  return text;
}

// ---------------------------- Отчёт ----------------------------

function buildReport_(date) {
  const sheet = getSheet_();
  const tz = tz_();
  const dateStr = Utilities.formatDate(date, tz, 'dd.MM.yyyy');
  const title = escapeHtml_(CONFIG.REPORT_TITLE);
  const layout = readLayout_(sheet);

  if (!layout.directions.length) {
    return '⚠️ ' + title + ' (' + dateStr + ')\nНе нашёл ни одного направления. ' +
      'Запустите «Проверить разметку»: в строке ' + CONFIG.ROW_METRICS +
      ' у каждого направления должна быть колонка «Бюджет».';
  }

  const dateRows = readDateRows_(sheet);
  const key = dayKey_(date, tz);
  const row = dateRows.filter(function (r) { return r.key === key; })[0];
  if (!row) {
    const example = dateRows.length ? dateRows[dateRows.length - 1].raw : '05.08.26';
    return '⚠️ ' + title + ': нет строки за ' + dateStr + '\n' +
      'В столбце A нет этой даты, поэтому день не посчитан. ' +
      'Заведите строку в том же формате, что у соседних (например, ' + escapeHtml_(example) + '), ' +
      'или запустите «Дозаполнить даты».';
  }

  const monthPrefix = key.slice(0, 7);
  const monthRows = dateRows.filter(function (r) {
    return r.key.slice(0, 7) === monthPrefix && r.key <= key;
  });
  const values = sheet.getDataRange().getValues();

  const blocks = [];
  let checked = 0, empty = 0, violationsTotal = 0;
  const skipped = [];

  layout.directions.forEach(function (d) {
    if (isSkipped_(d.name)) { skipped.push(d.name); return; }
    const day = readDay_(values[row.index], d.cols);
    if (day.isEmpty) { empty++; return; }
    checked++;
    const th = thresholdsFor_(d.name);
    const win = sumWindow_(values, dateRows, d.cols, date, th.CPL_WINDOW_DAYS || 1);
    const v = checkDay_(day, th, win);
    violationsTotal += v.length;
    const month = sumMonth_(values, monthRows, d.cols);
    blocks.push(formatBlock_(d.name, v, month, date, tz));
  });

  const footer = [];
  footer.push('Проверено направлений: ' + checked + ', без данных: ' + empty);
  if (skipped.length) footer.push('Не проверяются по настройке: ' + skipped.map(escapeHtml_).join(', '));
  const unknown = unknownKeys_(layout);
  if (unknown.length) footer.push('⚠️ В настройках нет в таблице: ' + unknown.map(escapeHtml_).join(', ') +
    '. Для них действуют общие пороги — проверьте написание.');
  if (layout.broken.length) {
    footer.push('❌ Не распознаны: ' + layout.broken.map(function (b) {
      return escapeHtml_(b.name) + ' (' + escapeHtml_(b.reason) + ')';
    }).join('; '));
  }

  if (checked === 0) {
    return '⚠️ ' + title + ' (' + dateStr + ')\n' +
      'Строка за день есть, но все направления пустые. Данных нет, отчёт не считался — это не «норма».\n\n' +
      footer.join('\n');
  }

  if (violationsTotal === 0) {
    return '✅ ' + title + ': норма (' + dateStr + ')\n' +
      'Все направления в пределах порогов.\n\n' + footer.join('\n');
  }

  return '🚨 ' + title + ': стоп-факторы (' + dateStr + ')\n\n' +
    blocks.join('\n\n') + '\n\n' + footer.join('\n');
}

function checkDay_(day, th, win) {
  const v = [];
  win = win || { budget: day.budget, leads: day.leads, days: 1 };
  const period = win.days > 1 ? ' за ' + plural_(win.days, 'день', 'дня', 'дней') : '';
  if (th.CPL_MAX !== null && win.budget > 0 && win.leads === 0 && win.budget >= CONFIG.ZERO_LEADS_MIN_BUDGET) {
    v.push('🔴 Бюджет' + period + ' ' + money_(win.budget) + ', лидов 0');
  }
  if (win.leads > 0 && th.CPL_MAX != null) {
    const cpl = win.budget / win.leads;
    if (cpl > th.CPL_MAX) {
      v.push('🔴 CPL' + period + ' ' + money_(cpl) + ' при пороге ' + money_(th.CPL_MAX) +
        ' (' + plural_(win.leads, 'лид', 'лида', 'лидов') + ', бюджет ' + money_(win.budget) + ')');
    }
  }
  if (day.impressions >= CONFIG.MIN_IMPRESSIONS_FOR_CTR && th.CTR_MIN != null) {
    const ctr = day.clicks / day.impressions;
    if (ctr < th.CTR_MIN) {
      v.push('📉 CTR ' + pct_(ctr) + ' при пороге ' + pct_(th.CTR_MIN) +
        ' (показов ' + num_(day.impressions) + ', кликов ' + num_(day.clicks) + ')');
    }
  }
  if (day.clicks >= CONFIG.MIN_CLICKS_FOR_CPC && th.CPC_MAX != null) {
    const cpc = day.budget / day.clicks;
    if (cpc > th.CPC_MAX) {
      v.push('💸 CPC ' + money_(cpc) + ' при пороге ' + money_(th.CPC_MAX) +
        ' (кликов ' + num_(day.clicks) + ', бюджет ' + money_(day.budget) + ')');
    }
  }
  return v;
}

function formatBlock_(name, violations, month, date, tz) {
  const head = violations.length
    ? '🚨 <b>' + escapeHtml_(name) + '</b> — ' + plural_(violations.length, 'нарушение', 'нарушения', 'нарушений')
    : '✅ <b>' + escapeHtml_(name) + '</b> — норма';
  const monthName = MONTHS_[Number(Utilities.formatDate(date, tz, 'M')) - 1];
  const cpl = month.leads > 0 ? ', CPL ' + money_(month.budget / month.leads) : '';
  const total = '<i>За ' + monthName + ': ' + money_(month.budget) + ', ' +
    plural_(month.leads, 'лид', 'лида', 'лидов') + cpl + '</i>';
  return [head].concat(violations).concat([total]).join('\n');
}

const MONTHS_ = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Сумма бюджета и лидов за последние n дней, включая отчётный. */
function sumWindow_(values, dateRows, cols, date, n) {
  const tz = tz_();
  const to = dayKey_(date, tz);
  const from = dayKey_(addDays_(date, -(n - 1)), tz);
  const s = { budget: 0, leads: 0, days: n };
  dateRows.forEach(function (r) {
    if (r.key >= from && r.key <= to) {
      const d = readDay_(values[r.index], cols);
      s.budget += d.budget;
      s.leads += d.leads;
    }
  });
  return s;
}

function sumMonth_(values, monthRows, cols) {
  const s = { budget: 0, leads: 0 };
  monthRows.forEach(function (r) {
    const d = readDay_(values[r.index], cols);
    s.budget += d.budget;
    s.leads += d.leads;
  });
  return s;
}

function readDay_(rowValues, cols) {
  const d = {
    budget: toNum_(rowValues[cols.budget]),
    impressions: toNum_(rowValues[cols.impressions]),
    clicks: toNum_(rowValues[cols.clicks]),
    leads: toNum_(rowValues[cols.leads]),
  };
  d.isEmpty = !d.budget && !d.impressions && !d.clicks && !d.leads;
  return d;
}

function describeThresholds_(th) {
  const parts = [];
  parts.push('CTR ' + (th.CTR_MIN == null ? 'не проверяется' : 'от ' + pct_(th.CTR_MIN)));
  parts.push('CPC ' + (th.CPC_MAX == null ? 'не проверяется' : 'до ' + money_(th.CPC_MAX)));
  parts.push('CPL ' + (th.CPL_MAX == null ? 'не проверяется' : 'до ' + money_(th.CPL_MAX)) +
    (th.CPL_WINDOW_DAYS > 1 ? ' за ' + plural_(th.CPL_WINDOW_DAYS, 'день', 'дня', 'дней') : ''));
  return parts.join(', ');
}

/** Названия из настроек, которых нет в таблице (опечатки). */
function unknownKeys_(layout) {
  const names = layout.directions.map(function (d) { return d.name; })
    .concat(layout.broken.map(function (b) { return b.name; }));
  const keys = Object.keys(CONFIG.THRESHOLDS_BY_DIRECTION).concat(CONFIG.SKIP_DIRECTIONS);
  return keys.filter(function (k, i) { return names.indexOf(k) === -1 && keys.indexOf(k) === i; });
}

function thresholdsFor_(name) {
  const own = CONFIG.THRESHOLDS_BY_DIRECTION[name] || {};
  const th = {};
  Object.keys(CONFIG.THRESHOLDS).forEach(function (k) { th[k] = CONFIG.THRESHOLDS[k]; });
  Object.keys(own).forEach(function (k) { th[k] = own[k]; });
  return th;
}

function isSkipped_(name) {
  return CONFIG.SKIP_DIRECTIONS.indexOf(name) !== -1;
}

// ---------------------------- Разметка ----------------------------

/**
 * Ищет направления: каждая колонка «Бюджет…» в строке метрик — начало блока.
 * Внутри блока (до следующего «Бюджет») ищет показы, клики и лиды по названиям.
 */
function readLayout_(sheet) {
  const lastCol = sheet.getLastColumn();
  const namesRow = sheet.getRange(CONFIG.ROW_DIRECTIONS, 1, 1, lastCol).getValues()[0];
  const metricsRow = sheet.getRange(CONFIG.ROW_METRICS, 1, 1, lastCol).getValues()[0];
  const norm = metricsRow.map(function (h) { return String(h).toLowerCase().trim(); });

  const starts = [];
  norm.forEach(function (h, i) { if (matches_(h, METRIC_NAMES.budget)) starts.push(i); });

  const directions = [], broken = [];
  starts.forEach(function (start, n) {
    const end = n + 1 < starts.length ? starts[n + 1] : lastCol;
    let name = String(namesRow[start] || '').trim();
    if (!name) {
      for (let j = start; j >= 0 && !name; j--) name = String(namesRow[j] || '').trim();
    }
    if (!name) name = 'Колонка ' + colLetter_(start);
    const cols = { budget: start, impressions: -1, clicks: -1, leads: -1 };
    for (let c = start + 1; c < end; c++) {
      ['impressions', 'clicks', 'leads'].forEach(function (m) {
        if (cols[m] === -1 && matches_(norm[c], METRIC_NAMES[m])) cols[m] = c;
      });
    }
    const missing = [];
    if (cols.impressions === -1) missing.push('показы');
    if (cols.clicks === -1) missing.push('клики');
    if (cols.leads === -1) missing.push('лиды');
    if (missing.length) broken.push({ name: name, reason: 'нет колонок: ' + missing.join(', ') });
    else directions.push({ name: name, cols: cols });
  });
  return { directions: directions, broken: broken };
}

function matches_(header, variants) {
  if (!header) return false;
  return variants.some(function (v) { return header.indexOf(v) === 0; });
}

/** Все строки, где в столбце A стоит дата (настоящая или текстом). */
function readDateRows_(sheet) {
  const tz = tz_();
  const lastRow = sheet.getLastRow();
  const first = CONFIG.ROW_METRICS + 1;
  if (lastRow < first) return [];
  const col = sheet.getRange(first, 1, lastRow - first + 1, 1).getValues();
  const disp = sheet.getRange(first, 1, lastRow - first + 1, 1).getDisplayValues();
  const rows = [];
  col.forEach(function (c, i) {
    const d = parseDate_(c[0]);
    if (d) rows.push({ index: first - 1 + i, key: dayKey_(d, tz), raw: disp[i][0] });
  });
  return rows;
}

// ---------------------------- Даты ----------------------------

/** Добавляет даты в столбец A до конца следующего месяца. Только даты, без цифр. */
function fillDates() {
  const sheet = getSheet_();
  const tz = tz_();
  const rows = readDateRows_(sheet);
  let last;
  let writeRow;
  if (rows.length) {
    const lastRow = rows[rows.length - 1];
    last = parseDate_(sheet.getRange(lastRow.index + 1, 1).getValue()) ||
      parseDate_(lastRow.raw);
    writeRow = lastRow.index + 2;
  } else {
    last = addDays_(today_(), -1);
    writeRow = Math.max(sheet.getLastRow() + 1, CONFIG.ROW_METRICS + 2);
  }
  const now = today_();
  const until = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const out = [];
  let d = addDays_(last, 1);
  // Полдень, чтобы разница часовых поясов скрипта и таблицы не сдвинула день.
  while (d <= until) { out.push([new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)]); d = addDays_(d, 1); }
  let msg;
  if (out.length) {
    const range = sheet.getRange(writeRow, 1, out.length, 1);
    range.setValues(out);
    range.setNumberFormat('dd.mm.yy');
    msg = 'Добавлено дат: ' + out.length + ', до ' + Utilities.formatDate(until, tz, 'dd.MM.yyyy') +
      '. Цифры в эти строки не протягивайте: заполняйте только фактом.';
  } else {
    msg = 'Даты уже есть до ' + Utilities.formatDate(until, tz, 'dd.MM.yyyy') + '.';
  }
  Logger.log(msg);
  const ui = tryUi_();
  if (ui) ui.alert(msg);
  return msg;
}

function parseDate_(v) {
  if (v instanceof Date && !isNaN(v)) {
    // День берём в часовом поясе таблицы, а не скрипта.
    const p = Utilities.formatDate(v, tz_(), 'yyyy-MM-dd').split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2}|\d{4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  if (d.getDate() !== Number(m[1])) return null;
  return d;
}

function dayKey_(d, tz) {
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function today_() {
  const tz = tz_();
  const s = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd').split('-');
  return new Date(Number(s[0]), Number(s[1]) - 1, Number(s[2]));
}

function reportDate_() {
  return addDays_(today_(), -CONFIG.REPORT_DAY_OFFSET);
}

function addDays_(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// ---------------------------- Телеграм ----------------------------

/** Спрашивает токен бота и ID чата и сохраняет их в свойствах скрипта. */
function setupTelegram() {
  const ui = tryUi_();
  if (!ui) {
    throw new Error('Запустите эту команду из таблицы: меню «Сторож рекламы» — «Настроить Телеграм». ' +
      'Или задайте TELEGRAM_TOKEN и TELEGRAM_CHAT_ID в Настройки проекта — Свойства скрипта.');
  }
  const t = ui.prompt('Настройка Телеграма', 'Токен бота от @BotFather:', ui.ButtonSet.OK_CANCEL);
  if (t.getSelectedButton() !== ui.Button.OK) return;
  const c = ui.prompt('Настройка Телеграма', 'ID чата или канала (для групп и каналов начинается с минуса):', ui.ButtonSet.OK_CANCEL);
  if (c.getSelectedButton() !== ui.Button.OK) return;
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TELEGRAM_TOKEN', t.getResponseText().trim());
  props.setProperty('TELEGRAM_CHAT_ID', c.getResponseText().trim());
  try {
    sendTelegram_('✅ ' + escapeHtml_(CONFIG.REPORT_TITLE) + ' подключён. Сюда будут приходить отчёты.');
    ui.alert('Готово: тестовое сообщение отправлено в Телеграм.');
  } catch (e) {
    ui.alert('Сохранил, но сообщение не ушло: ' + e.message);
  }
}

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    throw new Error('Не настроен Телеграм. Меню «Сторож рекламы» — «Настроить Телеграм».');
  }
  splitMessage_(text, 4000).forEach(function (part) {
    const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      payload: {
        chat_id: chatId,
        text: part,
        parse_mode: 'HTML',
        disable_web_page_preview: 'true',
      },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Телеграм ответил ' + resp.getResponseCode() + ': ' + resp.getContentText() +
        '. Проверьте токен, ID чата и что бот добавлен в чат администратором.');
    }
  });
}

function splitMessage_(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let cur = '';
  text.split('\n\n').forEach(function (chunk) {
    if ((cur + '\n\n' + chunk).length > limit && cur) { parts.push(cur); cur = chunk; }
    else cur = cur ? cur + '\n\n' + chunk : chunk;
  });
  if (cur) parts.push(cur);
  return parts;
}

// ---------------------------- Триггер ----------------------------

/** Включает ежедневный отчёт. Старые триггеры отчёта удаляет, чтобы не было дублей. */
function enableDailyTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReport') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(CONFIG.SEND_HOUR)
    .inTimezone(tz_()).create();
  const msg = 'Ежедневный отчёт включён: между ' + CONFIG.SEND_HOUR + ':00 и ' + (CONFIG.SEND_HOUR + 1) +
    ':00 (' + tz_() + '). ' +
    (removed ? 'Старых триггеров удалено: ' + removed + '.' : '');
  Logger.log(msg);
  const ui = tryUi_();
  if (ui) ui.alert(msg);
  return msg;
}

// ---------------------------- Мелочи ----------------------------

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!CONFIG.SHEET_NAME) return ss.getSheets()[0];
  const sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) throw new Error('Нет листа «' + CONFIG.SHEET_NAME + '». Проверьте SHEET_NAME в настройках.');
  return sh;
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function tryUi_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}

function toNum_(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[\s  ₽р$%]/gi, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function groupDigits_(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function money_(x) { return groupDigits_(Math.round(x)) + ' ₽'; }
function num_(x) { return groupDigits_(Math.round(x)); }
function pct_(x) { return (x * 100).toFixed(2).replace('.', ',') + '%'; }

function plural_(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  const w = (a > 10 && a < 20) ? many : (b > 1 && b < 5) ? few : (b === 1) ? one : many;
  return num_(n) + ' ' + w;
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml_(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function colLetter_(i) {
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
