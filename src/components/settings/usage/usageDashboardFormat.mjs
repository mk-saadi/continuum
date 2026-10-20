import { formatUsd, formatSignedUsd } from '../../../lib/costFormat.mjs';

export const COVERAGE_LABEL = Object.freeze({
  measured: 'Measured',
  partially_measured: 'Partial',
  partially_estimated: 'Partially estimated',
  estimated: 'Estimated',
  fully_measured: 'Fully measured',
  unavailable: 'Unavailable',
  not_applicable: 'Not applicable',
});

export const COMPLETENESS_LABEL = Object.freeze({
  fully_measured: 'Fully measured',
  estimated: 'Estimated',
  partially_estimated: 'Partially estimated',
  unavailable: 'Unavailable',
  not_applicable: 'Not applicable',
});

export function coverageLabel(value) {
  return COVERAGE_LABEL[value] ?? 'Unavailable';
}

export function completenessLabel(value) {
  return COMPLETENESS_LABEL[value] ?? 'Unavailable';
}

export function numberValue(value, coverage = 'measured', { local = false } = {}) {
  if (local || coverage === 'not_applicable') return 'Not applicable';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const number = value.toLocaleString();
  return coverage === 'partially_measured' || coverage === 'partially_estimated' ? `≥ ${number}` : number;
}

export function tokenValue(value, coverage = 'measured', { local = false } = {}) {
  return numberValue(value, coverage, { local });
}

export function costValue(value, coverage = 'measured', { local = false, prefixPartial = true } = {}) {
  if (local || coverage === 'not_applicable') return 'Not applicable';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (prefixPartial && (coverage === 'partially_measured' || coverage === 'partially_estimated')) {
    return `≥ ${formatUsd(value)}`;
  }
  return formatUsd(value);
}

export function savingsValue(value, coverage = 'measured', { local = false } = {}) {
  if (local || coverage === 'not_applicable') return 'Not applicable';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const prefix = coverage === 'partially_measured' ? '≥ ' : '';
  return `${prefix}${formatSignedUsd(value)}`;
}

export function rateValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? formatUsd(value) : '—';
}

export function periodLabel(period, groupBy) {
  if (!period) return '';
  if (groupBy === 'month') return period.slice(0, 7);
  if (groupBy === 'week') return `Week of ${period}`;
  return period;
}

export function shortPeriodLabel(period) {
  if (!period) return '';
  return period.length >= 10 ? period.slice(5) : period;
}

export function axisCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value === 0) return '$0';
  const magnitude = Math.abs(value);
  if (magnitude < 0.0001) return '<$0.0001';
  if (magnitude < 0.01) return `$${value.toFixed(4)}`;
  if (magnitude < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function sourceLabel(value) {
  if (!value) return 'Unavailable';
  return String(value).replaceAll('-', ' ');
}
