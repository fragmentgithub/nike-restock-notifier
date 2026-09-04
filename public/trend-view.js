import { aggregateRestockTrends } from './restock-trends.js';

export function createTrendView(root = document) {
  const product = root.querySelector('#trendProduct');
  const period = root.querySelector('#trendPeriod');
  const total = root.querySelector('#trendTotal');
  const peak = root.querySelector('#trendPeak');
  const range = root.querySelector('#trendRange');
  const message = root.querySelector('#trendMessage');
  const chart = root.querySelector('#trendChart');
  const doc = chart.ownerDocument;
  let lastState = null;
  let staleMessage = '';
  let productSignature = '';

  product.addEventListener('change', paint);
  period.addEventListener('change', paint);

  return {
    render(state, { stale = false } = {}) {
      lastState = state;
      staleMessage = stale ? 'ステータスの更新が遅延しています。最新の入荷が含まれていない可能性があります。' : '';
      product.disabled = false;
      period.disabled = false;
      paint();
    },
    unavailable({ preserveData = false } = {}) {
      staleMessage = '最新履歴を取得できないため、前回取得した履歴を表示しています。';
      if (preserveData && lastState) {
        paint();
        return;
      }
      lastState = null;
      product.disabled = true;
      period.disabled = true;
      total.textContent = '-';
      peak.textContent = '-';
      peak.removeAttribute('title');
      range.textContent = '-';
      message.className = 'trend-message error';
      message.textContent = '履歴を取得できません。次の更新で再確認します。';
      chart.replaceChildren();
      chart.setAttribute('aria-label', '入荷履歴を取得できないため、グラフを表示できません');
    },
  };

  function paint() {
    if (!lastState) return;
    const options = {
      styleColor: product.value || 'all',
      days: period.value === 'all' ? 'all' : Number(period.value),
    };
    let summary = aggregateRestockTrends(lastState, options);
    const codes = summary.products || [];
    const signature = JSON.stringify(codes);
    if (signature !== productSignature) {
      const choices = [['all', '全商品'], ...codes.map((code) => [code, code])];
      product.replaceChildren(...choices.map(([value, label]) => {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }));
      product.value = codes.includes(options.styleColor) ? options.styleColor : 'all';
      productSignature = signature;
      if (product.value !== options.styleColor) {
        options.styleColor = product.value;
        summary = aggregateRestockTrends(lastState, options);
      }
    }

    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: Math.max(0, Number(summary.hours?.find((item) => item.hour === hour)?.count) || 0),
    }));
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

    const remarks = [];
    if (staleMessage) remarks.push(staleMessage);
    if (summary.totalEvents === 0) {
      remarks.push('この条件に該当する入荷検出の記録はありません。');
    } else if (summary.totalEvents < 10) {
      remarks.push(`記録は${summary.totalEvents}件です。履歴が少ないため、時間帯の偏りは参考程度にご覧ください。`);
    } else {
      remarks.push('棒の高さは、その時間帯に入荷を検出した件数です。');
    }
    message.className = `trend-message${staleMessage ? ' error' : ''}`;
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

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}
