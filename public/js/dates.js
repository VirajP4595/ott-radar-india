// Date helpers. All dates are local calendar dates in "YYYY-MM-DD" form.
export const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
export const today = () => iso(new Date());
export const isValid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && iso(parse(s)) === s;
export const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};
export const weekStart = (s) => {
  const d = parse(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return iso(d);
};
export const monthKey = (s) => s.slice(0, 7);
export const monthStart = (mk) => `${mk}-01`;
export const monthEnd = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return iso(new Date(y, m, 0));
};
export const addMonths = (mk, n) => {
  const [y, m] = mk.split('-').map(Number);
  return iso(new Date(y, m - 1 + n, 1)).slice(0, 7);
};
export const monthsBetween = (a, b) => {
  const out = [];
  for (let k = monthKey(a); k <= monthKey(b); k = addMonths(k, 1)) out.push(k);
  return out;
};
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export const dayNum = (s) => Number(s.slice(8, 10));

const fmt = (s, o) => parse(s).toLocaleDateString('en-IN', o);
export const fmtDow = (s) => fmt(s, { weekday: 'short' });
export const fmtLong = (s) => fmt(s, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const fmtShort = (s) => fmt(s, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDayMonth = (s) => fmt(s, { day: 'numeric', month: 'short' });
export const fmtDate = (s) => fmt(s, { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtMonth = (mk) => fmt(`${mk}-01`, { month: 'long', year: 'numeric' });
export function fmtRange(a, b) {
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth
    ? `${dayNum(a)} – ${fmtDate(b)}`
    : `${fmtDayMonth(a)} – ${fmtDate(b)}`;
}
