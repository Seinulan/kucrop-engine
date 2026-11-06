// Графики Chart.js в цветах текущей темы. Пересоздаются при смене темы и языка.
import { t } from './i18n.js';
import { fmtDate } from './ui.js';

let charts = [];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
}

function common() {
  const muted = css('--muted'), faint = css('--faint'), line = css('--line');
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { sort: (a, b) => a.datasetIndex - b.datasetIndex, color: muted, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, padding: 14, font: { family: css('--font'), size: 12 } } },
      tooltip: { backgroundColor: css('--text'), titleColor: css('--bg'), bodyColor: css('--bg'), padding: 10, cornerRadius: 8, boxPadding: 4,
        titleFont: { family: css('--font'), weight: '600' }, bodyFont: { family: css('--font') } },
    },
    scales: {
      x: { grid: { display: false }, border: { color: line }, ticks: { color: faint, maxTicksLimit: 9, maxRotation: 0, autoSkipPadding: 14, font: { family: css('--font'), size: 11 } } },
      y: { grid: { color: line }, border: { display: false }, ticks: { color: faint, font: { family: css('--font'), size: 11 } } },
    },
  };
}

const labels = (r) => r.charts.dates.map((d) => fmtDate(d));

export function canopyChart(canvas, r) {
  if (!window.Chart || !r || !r.charts) return null;
  const o = common();
  o.scales.y.min = 0; o.scales.y.max = 100;
  o.scales.y.title = { display: true, text: '%', color: css('--faint') };
  o.scales.y1 = { position: 'right', min: 0, grid: { display: false }, border: { display: false }, ticks: { color: css('--faint') }, title: { display: true, text: t('u.mm'), color: css('--faint') } };
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: labels(r),
      datasets: [
        { label: t('chart.cc'), data: r.charts.canopy_cover, borderColor: css('--leaf-fill'), backgroundColor: css('--leaf-area'), fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2.2, yAxisID: 'y', order: 2 },
        { label: t('chart.tr'), data: r.charts.transpiration, borderColor: css('--water-fill'), borderDash: [5, 4], tension: 0.3, pointRadius: 0, borderWidth: 1.6, yAxisID: 'y1', order: 1 },
      ],
    },
    options: o,
  });
  charts.push(chart);
  return chart;
}

export function rainChart(canvas, r) {
  if (!window.Chart || !r || !r.charts) return null;
  const o = common();
  o.scales.y.beginAtZero = true;
  o.scales.y.title = { display: true, text: t('u.mm'), color: css('--faint') };
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels(r),
      datasets: [
        { label: t('chart.rain'), data: r.charts.rain, backgroundColor: css('--water-fill'), borderRadius: 3, barPercentage: 0.9, categoryPercentage: 1, order: 2 },
        { label: t('chart.cr'), data: r.charts.capillary_rise, type: 'line', borderColor: css('--soil'), backgroundColor: css('--soil-area'), fill: true, pointRadius: 0, tension: 0.3, borderWidth: 1.8, order: 1 },
      ],
    },
    options: o,
  });
  charts.push(chart);
  return chart;
}
