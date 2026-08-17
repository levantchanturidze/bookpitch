'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CalendarCheck, DollarSign, Percent, TrendingDown, TrendingUp, Users } from 'lucide-react';
import type { Metrics, RosterRow } from '@/lib/analytics';

type Props = {
  metrics: Metrics;
  roster: RosterRow[];
  currency: string;
};

export default function AnalyticsView({ metrics, roster, currency }: Props) {
  const accent =
    metrics.location.type === 'clinic' ? '#0d9488' /* teal-600 */ : '#db2777'; /* pink-600 */

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-slate-200 bg-white p-6">
        <p className="font-mono text-[10px] tracking-widest text-slate-400 uppercase">
          Business Intelligence · {metrics.refDate}
        </p>
        <h2 className="mt-1 text-xl font-extrabold tracking-tight text-slate-900">
          {metrics.location.name}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          All figures are for the active location, in UTC. Revenue counts only paid appointments;
          occupancy compares booked minutes against the staff availability windows for today.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Today’s revenue"
          value={formatMoney(metrics.revenue.current)}
          suffix={currency}
          delta={metrics.revenue.deltaPct}
          previous={`${formatMoney(metrics.revenue.previous)} ${currency}`}
          icon={DollarSign}
        />
        <KpiCard
          label="Today’s bookings"
          value={metrics.bookings.current.toString()}
          delta={metrics.bookings.deltaPct}
          previous={`${metrics.bookings.previous} last week`}
          icon={CalendarCheck}
        />
        <KpiCard
          label="Staff occupancy"
          value={
            metrics.occupancy.percent == null ? 'N/A' : `${metrics.occupancy.percent.toFixed(0)}%`
          }
          suffix={
            metrics.occupancy.percent == null
              ? 'no windows today'
              : `${metrics.occupancy.bookedMinutes} / ${metrics.occupancy.availableMinutes} min`
          }
          icon={Percent}
        />
        <KpiCard
          label="Avg ticket · 30d"
          value={formatMoney(metrics.averageTicket.amount)}
          suffix={`${currency} · n=${metrics.averageTicket.sampleSize}`}
          icon={Users}
        />
      </div>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 xl:col-span-2">
          <h3 className="mb-2 text-sm font-bold text-slate-800">7-day revenue trend</h3>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metrics.trend} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#94a3b8', fontSize: 10 }}
                  tickFormatter={(d) => (d as string).slice(5)}
                  axisLine={{ stroke: '#e2e8f0' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#94a3b8', fontSize: 10 }}
                  axisLine={{ stroke: '#e2e8f0' }}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                    fontSize: 12,
                  }}
                  formatter={(value, name) => [String(value), String(name).toUpperCase()]}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke={accent}
                  fill={accent}
                  fillOpacity={0.15}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <h3 className="mb-2 text-sm font-bold text-slate-800">Bookings per staff · 7d</h3>
          <div className="h-56 w-full">
            {metrics.bookingsPerStaff.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">
                No bookings in the last 7 days.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={metrics.bookingsPerStaff}
                  margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="2 4" stroke="#e2e8f0" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: '#94a3b8', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="staffName"
                    tick={{ fill: '#94a3b8', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={110}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
                  />
                  <Bar dataKey="bookings" fill={accent} radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white">
        <header className="border-b border-slate-100 px-6 py-3">
          <h3 className="font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
            Daily staff roster — {roster.length}
          </h3>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 bg-slate-50 font-mono text-[10px] tracking-wider text-slate-500 uppercase">
              <tr>
                <th scope="col" className="px-6 py-2 font-medium">
                  Staff
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Role
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Today’s window
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Booked / avail
                </th>
                <th scope="col" className="px-6 py-2 text-right font-medium">
                  Appointments
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roster.map((r) => (
                <tr key={r.staffId}>
                  <td className="px-6 py-2 font-bold text-slate-800">{r.staffName}</td>
                  <td className="px-2 py-2 text-slate-500">{r.roleTitle}</td>
                  <td className="px-2 py-2 font-mono text-[11px] text-slate-600">
                    {r.window ? (
                      `${r.window.start} – ${r.window.end}`
                    ) : (
                      <span className="text-slate-400">off today</span>
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] text-slate-600">
                    {r.bookedMinutes} / {r.availableMinutes} min
                  </td>
                  <td className="px-6 py-2 text-right font-mono font-bold text-slate-700">
                    {r.appointmentCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// KPI card
// -----------------------------------------------------------------------------
function KpiCard({
  label,
  value,
  suffix,
  delta,
  previous,
  icon: Icon,
}: {
  label: string;
  value: string;
  suffix?: string;
  delta?: number | null;
  previous?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between">
        <span className="font-mono text-[10px] tracking-wider text-slate-400 uppercase">
          {label}
        </span>
        <Icon className="h-4 w-4 text-slate-300" />
      </div>
      <p className="mt-3 text-2xl font-extrabold text-slate-900">
        {value}
        {suffix && (
          <span className="ml-1 font-mono text-xs font-normal text-slate-400">{suffix}</span>
        )}
      </p>
      {delta !== undefined && (
        <div className="mt-2 flex items-center gap-1 text-[11px]">
          {delta == null ? (
            <span className="text-slate-400">No comparable data</span>
          ) : delta === 0 ? (
            <span className="text-slate-500">= vs last {'week'}</span>
          ) : delta > 0 ? (
            <span className="flex items-center gap-1 text-emerald-600">
              <TrendingUp className="h-3 w-3" /> +{delta.toFixed(0)}%
            </span>
          ) : (
            <span className="flex items-center gap-1 text-rose-600">
              <TrendingDown className="h-3 w-3" /> {delta.toFixed(0)}%
            </span>
          )}
          {previous && <span className="text-slate-400">· prev {previous}</span>}
        </div>
      )}
    </div>
  );
}

function formatMoney(n: number): string {
  return n.toFixed(2);
}
