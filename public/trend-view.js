const TREND_TIMEOUT_MS = 15000;
const PERIODS = new Set(['all', '7', '30', '90', '365', '730']);
const STYLE_COLOR_PATTERN = /^[A-Z0-9]{5,8}-[A-Z0-9]{3}$/;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function createTrendView(root = document) {
  const product = root.querySelector('#trendProduct');
  const period = root.querySelector('#trendPeriod');
  const total = root.querySelector('#trendTotal');
  const peak = root.querySelector('#trendPeak');
  const range = root.querySelector('#trendRange');
  const message = root.querySelector('#trendMessage');
  const chart = root.querySelector('#trendChart');
  const retention = root.querySelector('#trendRetention');
  const selloutEstimate = root.querySelector('#selloutEstimate');
  const selloutDetail = root.querySelector('#selloutDetail');
  const comparisonValue = root.querySelector('#comparisonValue');
  const comparisonDetail = root.querySelector('#comparisonDetail');
  const coverageValue = root.querySelector('#coverageValue');
  const coverageDetail = root.querySelector('#coverageDetail');
  const heatmapHead = root.querySelector('#trendHeatmapHead');
  const heatmapBody = root.querySelector('#trendHeatmapBody');
  const analysisNote = root.querySelector('#analysisNote');
  const doc = chart.ownerDocument;
  const summaries = new Map();
  let monitorNotice = '';
  let productSignature = '';
  let requestId = 0;
  let controller = null;
  let loading = false;
  let loadError = '';
  let renderedAnalytics;

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
      if (renderedAnalytics !== null) {
        renderAnalytics(null);
        renderedAnalytics = null;
      }
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
    if (renderedAnalytics !== summary.analytics) {
      renderAnalytics(summary.analytics);
      renderedAnalytics = summary.analytics;
    }
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

  function renderAnalytics(analytics) {
    if (!analytics) {
      selloutEstimate.textContent = '-';
      selloutDetail.textContent = '推定に必要な記録がありません。';
      comparisonValue.textContent = '-';
      comparisonDetail.textContent = '比較に必要な記録がありません。';
      coverageValue.textContent = '-';
      coverageDetail.textContent = '監視時間の記録がありません。';
      analysisNote.textContent = '監視時間を記録できなかった期間は補正しません。分析データを取得できていません。';
      emptyHeatmap('分析に必要な監視時間の記録がありません。');
      return;
    }
    renderSellout(analytics.sellout);
    renderComparison(analytics.comparison);
    renderCoverage(analytics.coverage);
    renderHeatmap(analytics.weekdayHours.cells, { truncated: analytics.coverage.segmentsTruncated === true });
    renderAnalysisNote(analytics);
  }

  function renderSellout(sellout) {
    if (sellout.samplesTruncated === true) {
      selloutEstimate.textContent = '表示不可';
      selloutDetail.textContent = '記録量が集計上限を超えたため、部分的な記録から所要時間を推定しません。';
      return;
    }
    selloutEstimate.textContent = sellout.sampleCount > 0 && sellout.medianMinutes !== null
      ? `約${formatDuration(sellout.medianMinutes)}` : 'データ不足';
    const interval = sellout.medianLowerMinutes !== null && sellout.medianUpperMinutes !== null
      ? `（観測幅 ${formatDuration(sellout.medianLowerMinutes)}〜${formatDuration(sellout.medianUpperMinutes)}）` : '';
    selloutDetail.textContent = `確定した売り切れ ${sellout.sampleCount.toLocaleString('ja-JP')}件${interval}。` +
      `追跡中・打ち切り ${sellout.censoredCount.toLocaleString('ja-JP')}件は推定から除外。`;
  }

  function renderComparison(comparison) {
    const change = comparison.changePercent;
    comparisonValue.textContent = comparison.status === 'insufficient' || change === null
      ? 'データ不足'
      : comparison.status === 'flat'
        ? `ほぼ横ばい（${signedPercent(change)}）`
        : `${comparison.status === 'up' ? '増加' : '減少'}（${signedPercent(change)}）`;
    comparisonDetail.textContent = [
      comparisonPeriod('最近30日', comparison.current),
      comparisonPeriod('直前30日', comparison.previous),
      comparison.status === 'insufficient'
        ? `各期間${comparison.minSampleRequired.eventsPerPeriod}件以上かつ` +
          `${formatNumber(comparison.minSampleRequired.observedProductHoursPerPeriod)}商品時間以上になるまで傾向を判定しません。` : '',
    ].filter(Boolean).join(' / ');
  }

  function renderCoverage(coverage) {
    coverageValue.textContent = coverage.segmentsTruncated === true
      ? '補正不可'
      : coverage.observedProductHours === null
      ? '未観測' : `${formatNumber(coverage.observedProductHours)}商品時間`;
    coverageDetail.textContent = coverage.segmentsTruncated === true
      ? '記録量が集計上限を超えたため、商品監視時間と補正率を表示しません。'
      : `${coverage.reliableSegments.toLocaleString('ja-JP')}区間を集計 / ` +
        `${coverage.excludedGaps.toLocaleString('ja-JP')}区間を除外`;
  }

  function renderAnalysisNote(analytics) {
    const limits = [];
    if (analytics.coverage.segmentsTruncated === true) limits.push('補正率');
    if (analytics.sellout.samplesTruncated === true) limits.push('売り切れまでの所要時間');
    if (limits.length) {
      analysisNote.textContent = `記録量が集計上限を超えたため、${limits.join('と')}は表示できません。部分集計から傾向を推測していません。`;
      return;
    }
    const started = formatDate(analytics.coverage.recordingStartedAt);
    analysisNote.textContent = `監視時間の記録は${started}からです。記録がない過去の期間は補完せず、` +
      '未観測として頻度計算から除外します。入荷件数が少ない場合は傾向判断に適しません。';
  }

  function renderHeatmap(cells, { truncated = false } = {}) {
    const lookup = new Map(cells.map((cell) => [`${cell.weekday}|${cell.hour}`, cell]));
    const maxRate = Math.max(0, ...cells.map((cell) => cell.ratePer100ProductHours ?? 0));
    const header = doc.createElement('tr');
    const corner = doc.createElement('th');
    corner.scope = 'col';
    corner.textContent = '曜日';
    header.append(corner);
    for (let hour = 0; hour < 24; hour++) {
      const cell = doc.createElement('th');
      cell.scope = 'col';
      cell.textContent = `${hour}時`;
      header.append(cell);
    }
    heatmapHead.replaceChildren(header);
    const rows = WEEKDAYS.map((weekday, weekdayIndex) => {
      const row = doc.createElement('tr');
      const label = doc.createElement('th');
      label.scope = 'row';
      label.textContent = weekday;
      row.append(label);
      for (let hour = 0; hour < 24; hour++) {
        const data = lookup.get(`${weekdayIndex}|${hour}`);
        const cell = doc.createElement('td');
        const count = doc.createElement('span');
        const rate = doc.createElement('small');
        count.textContent = `${data.restockEvents}件`;
        const observed = data.observedProductHours;
        if (observed === null) {
          cell.className = 'unobserved';
          rate.textContent = truncated ? '補正不可' : '未観測';
          cell.title = truncated
            ? `${weekday}曜${hour}時台：入荷${data.restockEvents}件、集計上限超過のため補正不可`
            : `${weekday}曜${hour}時台：入荷${data.restockEvents}件、監視時間の記録なし（補正不可）`;
        } else {
          const normalizedRate = data.ratePer100ProductHours;
          const level = normalizedRate > 0 && maxRate > 0 ? Math.ceil((normalizedRate / maxRate) * 4) : 0;
          cell.className = level ? `heat-${level}` : '';
          rate.textContent = normalizedRate.toFixed(1);
          cell.title = `${weekday}曜${hour}時台：入荷${data.restockEvents}件、` +
            `観測${formatNumber(observed)}商品時間、100商品時間あたり${normalizedRate.toFixed(1)}件`;
        }
        cell.append(count, rate);
        row.append(cell);
      }
      return row;
    });
    heatmapBody.replaceChildren(...rows);
  }

  function emptyHeatmap(text) {
    heatmapHead.replaceChildren();
    const row = doc.createElement('tr');
    const cell = doc.createElement('td');
    cell.colSpan = 25;
    cell.textContent = text;
    row.append(cell);
    heatmapBody.replaceChildren(row);
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
  if (summary.analytics !== undefined && !validAnalytics(summary.analytics)) invalid();
}

function validAnalytics(analytics) {
  if (!analytics || !validCoverage(analytics.coverage) ||
      !analytics.weekdayHours || !Array.isArray(analytics.weekdayHours.cells) ||
      analytics.weekdayHours.cells.length !== 168 || !validSellout(analytics.sellout) ||
      !validComparison(analytics.comparison)) return false;
  const positions = new Set();
  for (const cell of analytics.weekdayHours.cells) {
    if (!cell || !Number.isInteger(cell.weekday) || cell.weekday < 0 || cell.weekday > 6 ||
        !Number.isInteger(cell.hour) || cell.hour < 0 || cell.hour > 23 ||
        !nonNegativeInteger(cell.restockEvents) || !validRatePair(cell) ||
        positions.has(`${cell.weekday}|${cell.hour}`)) return false;
    positions.add(`${cell.weekday}|${cell.hour}`);
  }
  return true;
}

function validCoverage(value) {
  return value && typeof value.recordingStartedAt === 'string' &&
    Number.isFinite(Date.parse(value.recordingStartedAt)) &&
    nullableNonNegative(value.observedProductHours) && nonNegativeInteger(value.reliableSegments) &&
    nonNegativeInteger(value.excludedGaps) && optionalBoolean(value.segmentsTruncated);
}

function validSellout(value) {
  return value && nonNegativeInteger(value.sampleCount) && nonNegativeInteger(value.censoredCount) &&
    ['medianMinutes', 'p25Minutes', 'p75Minutes', 'medianLowerMinutes', 'medianUpperMinutes']
      .every((key) => nullableNonNegative(value[key])) && optionalBoolean(value.samplesTruncated);
}

function validComparison(value) {
  return value && ['up', 'down', 'flat', 'insufficient'].includes(value.status) &&
    value.minSampleRequired && nonNegativeInteger(value.minSampleRequired.eventsPerPeriod) &&
    Number.isFinite(value.minSampleRequired.observedProductHoursPerPeriod) &&
    value.minSampleRequired.observedProductHoursPerPeriod > 0 &&
    (value.changePercent === null || Number.isFinite(value.changePercent)) &&
    validComparisonPeriod(value.current) && validComparisonPeriod(value.previous);
}

function validComparisonPeriod(value) {
  return value && nonNegativeInteger(value.events) && validRatePair(value);
}

function validRatePair(value) {
  if (value.observedProductHours === null) return value.ratePer100ProductHours === null;
  return Number.isFinite(value.observedProductHours) && value.observedProductHours > 0 &&
    Number.isFinite(value.ratePer100ProductHours) && value.ratePer100ProductHours >= 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nullableNonNegative(value) {
  return value === null || Number.isFinite(value) && value >= 0;
}

function optionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function comparisonPeriod(label, value) {
  return `${label}: ${value.events.toLocaleString('ja-JP')}件、` +
    (value.ratePer100ProductHours === null
      ? '監視時間未観測' : `100商品時間あたり${value.ratePer100ProductHours.toFixed(1)}件`);
}

function signedPercent(value) {
  return `${value > 0 ? '+' : ''}${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`;
}

function formatNumber(value) {
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

function formatDuration(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}分`;
  if (minutes < 1440) return `${(minutes / 60).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}時間`;
  return `${(minutes / 1440).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}日`;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}
