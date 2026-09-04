const TREND_TIMEOUT_MS = 15000;
const PERIODS = new Set(['all', '7', '30', '90', '365', '730']);
const STYLE_COLOR_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/;

export function createTrendView(root = document) {
  const product = root.querySelector('#trendProduct');
  const period = root.querySelector('#trendPeriod');
  const total = root.querySelector('#trendTotal');
  const peak = root.querySelector('#trendPeak');
  const range = root.querySelector('#trendRange');
  const message = root.querySelector('#trendMessage');
  const chart = root.querySelector('#trendChart');
  const retention = root.querySelector('#trendRetention');
  const doc = chart.ownerDocument;
  const summaries = new Map();
  let monitorNotice = '';
  let productSignature = '';
  let requestId = 0;
  let controller = null;
  let loading = false;
  let loadError = '';

  product.addEventListener('change', () => void refresh());
  period.addEventListener('change', () => void refresh());

  return {
    refresh,
    setMonitorStatus({ stale = false, unavailable = false } = {}) {
      monitorNotice = unavailable
        ? '監視状態は取得できていません。集計はサーバーに保存された履歴です。'
        : stale ? 'ステータスの更新が遅延しています。最新の入荷が含まれていない可能性があります。' : '';
      paint();
    },
  };

  function selectedFilters() {
    return {
      styleColor: product.value || 'all',
      days: PERIODS.has(period.value) ? period.value : 'all',
    };
  }

  function filterKey(filters = selectedFilters()) {
    return `${filters.styleColor}|${filters.days}`;
  }

  async function refresh() {
    controller?.abort();
    controller = new AbortController();
    const currentController = controller;
    const currentId = ++requestId;
    const filters = selectedFilters();
    const key = filterKey(filters);
    const timeoutId = setTimeout(() => currentController.abort(), TREND_TIMEOUT_MS);
    loading = true;
    loadError = '';
    product.disabled = false;
    period.disabled = false;
    paint();
    try {
      const response = await fetch(`/api/trends?${new URLSearchParams(filters)}`, {
        cache: 'no-store', credentials: 'same-origin', signal: currentController.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 401 || response.status === 403
          ? 'ページを再読み込みしてログインし直してください。' : '長期集計の取得に失敗しました。');
      }
      const summary = await response.json();
      // An aborted fetch can still finish in a browser/cache or test adapter.
      // Neither its result nor its error may replace a newer filter selection.
      if (currentId !== requestId || filterKey() !== key) return;
      validateSummary(summary, filters);
      summaries.delete(key);
      summaries.set(key, summary);
      if (summaries.size > 64) summaries.delete(summaries.keys().next().value);
      updateProducts(summary.products, filters.styleColor);
    } catch (error) {
      if (currentId !== requestId || filterKey() !== key) return;
      loadError = error?.name === 'AbortError'
        ? '集計の応答がありません。次の更新で再確認します。'
        : error instanceof SyntaxError
          ? '集計を読み取れません。ページを再読み込みしてログイン状態を確認してください。'
          : error?.message || '長期集計の取得に失敗しました。';
    } finally {
      clearTimeout(timeoutId);
      if (currentId === requestId) {
        controller = null;
        loading = false;
        paint();
      }
    }
  }

  function updateProducts(codes, selectedStyle) {
    // Keep the requested product selected even if its last retained event has
    // just expired. Its zero result must not become an "all products" result.
    const choices = [...new Set([...codes, ...(selectedStyle === 'all' ? [] : [selectedStyle])])].sort();
    const signature = JSON.stringify(choices);
    if (signature === productSignature) return;
    product.replaceChildren(...[['all', '全商品'], ...choices.map((code) => [code, code])].map(([value, label]) => {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    product.value = selectedStyle;
    productSignature = signature;
  }

  function paint() {
    const summary = summaries.get(filterKey());
    const remarks = [];
    if (monitorNotice) remarks.push(monitorNotice);
    if (loading) remarks.push(summary
      ? '集計を更新しています。現在は選択中の条件の前回集計を表示しています。'
      : '選択した条件で長期履歴を集計しています。');
    if (loadError) remarks.push(summary
      ? `集計を更新できません。選択中の条件で前回取得した集計を表示しています。${loadError}`
      : `この条件の長期集計を取得できません。${loadError}`);
    chart.setAttribute('aria-busy', String(loading));
    message.className = `trend-message${loadError || monitorNotice ? ' error' : ''}`;
    if (!summary) {
      total.textContent = '-';
      peak.textContent = '-';
      peak.removeAttribute('title');
      range.textContent = '-';
      message.textContent = remarks.join(' ') || '長期履歴を読み込み中です。';
      chart.replaceChildren();
      chart.setAttribute('aria-label', loading
        ? '選択中の条件の長期履歴を読み込み中です'
        : '選択中の条件の長期履歴を取得できないため、グラフを表示できません');
      return;
    }
    const hours = [...summary.hours].sort((a, b) => a.hour - b.hour);
    if (typeof summary.notes?.retentionLabel === 'string') {
      retention.textContent = summary.notes.retentionLabel;
    }
    const maxCount = Math.max(...hours.map((hour) => hour.count));
    const peakHours = hours.filter((hour) => maxCount > 0 && hour.count === maxCount);
    total.textContent = `${summary.totalEvents.toLocaleString('ja-JP')}件`;
    const peakText = peakHours.map((hour) => `${String(hour.hour).padStart(2, '0')}時台`).join('・');
    peak.textContent = peakHours.length > 4
      ? `${String(peakHours[0].hour).padStart(2, '0')}時台ほか${peakHours.length - 1}時間帯（各${maxCount}件）`
      : maxCount > 0 ? `${peakText}（${maxCount}件${peakHours.length > 1 ? 'ずつ' : ''}）` : '-';
    if (maxCount) peak.title = `${peakText}：各${maxCount}件`;
    else peak.removeAttribute('title');
    range.textContent = summary.period.retainedFrom
      ? `${formatDate(summary.period.retainedFrom)} ～ ${formatDate(summary.period.retainedTo)}`
      : '履歴なし';

    if (summary.totalEvents === 0) {
      remarks.push('この条件に該当する入荷検出の記録はありません。');
    } else if (summary.totalEvents < 10) {
      remarks.push(`記録は${summary.totalEvents}件です。履歴が少ないため、時間帯の偏りは参考程度にご覧ください。`);
    } else {
      remarks.push('棒の高さは、その時間帯に入荷を検出した件数です。');
    }
    if (summary.notes?.productsTruncated) remarks.push('商品数が多いため、選択肢の一部を省略しています。');
    message.textContent = remarks.join(' ');
    renderChart(hours, maxCount);
  }

  function renderChart(hours, maxCount) {
    const fragment = doc.createDocumentFragment();
    for (const { hour, count } of hours) {
      const slot = doc.createElement('div');
      slot.className = 'trend-hour';
      slot.title = `${hour}時台：${count}件`;
      slot.setAttribute('aria-hidden', 'true');
      const column = doc.createElement('div');
      column.className = 'trend-column';
      const value = doc.createElement('span');
      value.className = 'trend-bar-count';
      value.textContent = count > 0 ? String(count) : '';
      const bar = doc.createElement('span');
      bar.className = 'trend-bar';
      bar.style.setProperty('--bar-size', `${maxCount ? (count / maxCount) * 84 : 0}%`);
      column.append(value, bar);
      const label = doc.createElement('span');
      label.className = 'trend-hour-label';
      label.textContent = hour % 3 === 0 ? `${hour}時` : '';
      slot.append(column, label);
      fragment.append(slot);
    }
    chart.replaceChildren(fragment);
    chart.setAttribute('aria-label', `日本時間の入荷検出件数。${hours.map(({ hour, count }) => `${hour}時台${count}件`).join('、')}`);
  }
}

function validateSummary(summary, filters) {
  const invalid = () => { throw new Error('長期集計の応答形式が不正です。'); };
  if (!summary || summary.timezone !== 'Asia/Tokyo' || summary.styleColor !== filters.styleColor ||
      String(summary.period?.days) !== filters.days ||
      !Number.isSafeInteger(summary.totalEvents) || summary.totalEvents < 0 ||
      !Array.isArray(summary.products) || !summary.products.every((code) =>
        typeof code === 'string' && STYLE_COLOR_PATTERN.test(code)) ||
      !Array.isArray(summary.hours) || summary.hours.length !== 24) invalid();
  const uniqueHours = new Set();
  let totalCount = 0;
  for (const item of summary.hours) {
    if (!item || !Number.isInteger(item.hour) || item.hour < 0 || item.hour > 23 ||
        !Number.isSafeInteger(item.count) || item.count < 0 || uniqueHours.has(item.hour)) invalid();
    uniqueHours.add(item.hour);
    totalCount += item.count;
  }
  if (totalCount !== summary.totalEvents) invalid();
  for (const date of [summary.period.retainedFrom, summary.period.retainedTo]) {
    if (date !== null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) invalid();
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}
