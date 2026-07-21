import { useMemo } from 'react';
import { DollarSign, CalendarCheck, TrendingUp, Users, Clock, ShieldCheck, Smile } from 'lucide-react';
import { Appointment, Staff, WorkspaceMode } from '@/lib/types';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar, Cell, Legend } from 'recharts';

interface AnalyticsDashboardProps {
  mode: WorkspaceMode;
  appointments: Appointment[];
  staff: Staff[];
}

export default function AnalyticsDashboard({ mode, appointments, staff }: AnalyticsDashboardProps) {
  const isClinic = mode === 'clinic';

  // Metrics calculations
  const metrics = useMemo(() => {
    // Current date is 2026-07-21
    const todayBookings = appointments.filter((a) => a.date === '2026-07-21' && a.status !== 'cancelled');
    const completedBookings = appointments.filter((a) => a.status === 'completed');

    const dailyRevenue = todayBookings.reduce((sum, item) => sum + item.price, 0);
    const totalBookingsCount = appointments.filter((a) => a.status !== 'cancelled').length;

    // Average transaction size
    const totalCompletedRevenue = completedBookings.reduce((sum, item) => sum + item.price, 0);
    const avgTicket = completedBookings.length > 0 ? totalCompletedRevenue / completedBookings.length : 125;

    // Average occupancy rate (hours booked / total available hours)
    // For prototype, let's compute a realistic ratio based on staff counts
    const occupancyRate = 82.4; // 82.4% occupied

    return {
      dailyRevenue,
      todayBookingsCount: todayBookings.length,
      totalBookingsCount,
      avgTicket,
      occupancyRate,
    };
  }, [appointments]);

  // Recharts Data 1: Last 7 Days Revenue Trend
  const chartData = useMemo(() => {
    // We create realistic progression
    return [
      { day: 'Jul 15', revenue: 780, appointments: 5 },
      { day: 'Jul 16', revenue: 920, appointments: 6 },
      { day: 'Jul 17', revenue: 1140, appointments: 8 },
      { day: 'Jul 18', revenue: 850, appointments: 5 },
      { day: 'Jul 19', revenue: 1250, appointments: 9 },
      { day: 'Jul 20', revenue: 1480, appointments: 11 },
      { day: 'Jul 21', revenue: metrics.dailyRevenue || 1850, appointments: metrics.todayBookingsCount || 13 },
    ];
  }, [metrics]);

  // Recharts Data 2: Appointments Booked by Staff Member
  const staffChartData = useMemo(() => {
    return staff.map((st) => {
      const staffBookings = appointments.filter((a) => a.staffId === st.id && a.status !== 'cancelled');
      return {
        name: st.name.split(' ')[1], // Just last name or first name for spacing
        bookings: staffBookings.length,
        color: st.color,
      };
    });
  }, [appointments, staff]);

  return (
    <div className="space-y-6" id="analytics-dashboard-root">
      {/* 4 Metric KPI Widgets */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="analytics-kpi-grid">
        {/* Metric 1 */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold text-slate-400 tracking-wider block uppercase">
              Daily Revenue
            </span>
            <h3 className="text-xl font-extrabold text-slate-800 mt-1 font-mono">
              ${metrics.dailyRevenue.toFixed(2)}
            </h3>
            <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-0.5 mt-1">
              <TrendingUp className="h-3 w-3" /> +18.4% vs last Tuesday
            </span>
          </div>
          <div className={`p-3.5 rounded-xl ${isClinic ? 'bg-teal-50 text-teal-600' : 'bg-pink-50 text-pink-600'}`}>
            <DollarSign className="h-5 w-5" />
          </div>
        </div>

        {/* Metric 2 */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold text-slate-400 tracking-wider block uppercase">
              Today's Bookings
            </span>
            <h3 className="text-xl font-extrabold text-slate-800 mt-1 font-mono">
              {metrics.todayBookingsCount}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 font-medium">
              {appointments.filter((a) => a.date === '2026-07-21' && a.status === 'completed').length} completed already
            </p>
          </div>
          <div className="p-3.5 bg-blue-50 text-blue-600 rounded-xl">
            <CalendarCheck className="h-5 w-5" />
          </div>
        </div>

        {/* Metric 3 */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold text-slate-400 tracking-wider block uppercase">
              Staff Occupancy
            </span>
            <h3 className="text-xl font-extrabold text-slate-800 mt-1 font-mono">
              {metrics.occupancyRate}%
            </h3>
            <span className="text-[10px] text-slate-500 font-medium mt-1 block">
              Optimal threshold met
            </span>
          </div>
          <div className="p-3.5 bg-amber-50 text-amber-600 rounded-xl">
            <Clock className="h-5 w-5" />
          </div>
        </div>

        {/* Metric 4 */}
        <div className="bg-white p-5 rounded-xl border border-slate-200 flex items-center justify-between">
          <div>
            <span className="text-[10px] font-bold text-slate-400 tracking-wider block uppercase">
              Avg Ticket Value
            </span>
            <h3 className="text-xl font-extrabold text-slate-800 mt-1 font-mono">
              ${metrics.avgTicket.toFixed(2)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 font-medium">Per completed session</p>
          </div>
          <div className="p-3.5 bg-indigo-50 text-indigo-600 rounded-xl">
            <Smile className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* Visual Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="analytics-charts-grid">
        {/* Revenue Area Chart (7 Columns) */}
        <div className="lg:col-span-7 bg-white p-5 rounded-xl border border-slate-200 flex flex-col h-[380px]" id="revenue-chart-card">
          <div className="mb-4">
            <h4 className="text-xs font-bold text-slate-800 tracking-wide uppercase">Revenue Growth Trends</h4>
            <p className="text-[10px] text-slate-400">Aggregated performance over the past 7 days</p>
          </div>

          <div className="flex-1 w-full text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={isClinic ? '#0d9488' : '#db2777'} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={isClinic ? '#0d9488' : '#db2777'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tickLine={false} axisLine={false} dy={10} style={{ fill: '#94a3b8', fontSize: 10 }} />
                <YAxis tickLine={false} axisLine={false} style={{ fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    borderRadius: '8px',
                    color: '#fff',
                    border: 'none',
                    fontSize: '11px',
                  }}
                  formatter={(value: any) => [`$${value}`, 'Revenue']}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke={isClinic ? '#0d9488' : '#db2777'}
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#colorRevenue)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Staff Bookings Count Bar Chart (5 Columns) */}
        <div className="lg:col-span-5 bg-white p-5 rounded-xl border border-slate-200 flex flex-col h-[380px]" id="staff-chart-card">
          <div className="mb-4">
            <h4 className="text-xs font-bold text-slate-800 tracking-wide uppercase">
              {isClinic ? 'Doctor Intake Share' : 'Stylist Session Volume'}
            </h4>
            <p className="text-[10px] text-slate-400">Total appointments booked per practitioner</p>
          </div>

          <div className="flex-1 w-full text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={staffChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <XAxis dataKey="name" tickLine={false} axisLine={false} dy={5} style={{ fill: '#94a3b8', fontSize: 10 }} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} style={{ fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    borderRadius: '8px',
                    color: '#fff',
                    border: 'none',
                    fontSize: '11px',
                  }}
                  formatter={(value: any) => [`${value} bookings`, 'Bookings']}
                />
                <Bar dataKey="bookings" radius={[4, 4, 0, 0]}>
                  {staffChartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Staff Availability & Roster matrix */}
      <div className="bg-white p-6 rounded-xl border border-slate-200" id="staff-availability-card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-xs font-bold text-slate-800 tracking-wide uppercase">Daily Staff Roster & Availability</h4>
            <p className="text-[10px] text-slate-400">Track practitioners availability, ratings, and operating constraints</p>
          </div>
          <span className="text-[10px] bg-slate-50 border border-slate-100 text-slate-500 font-mono font-semibold px-2 py-1 rounded">
            ROSTER VERIFIED
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                <th className="py-3 px-4">Staff Member</th>
                <th className="py-3 px-4">Role / Specialty</th>
                <th className="py-3 px-4">Roster Days</th>
                <th className="py-3 px-4">Operational Hours</th>
                <th className="py-3 px-4 text-center">Satisfaction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {staff.map((st) => (
                <tr key={st.id} className="hover:bg-slate-50/50 transition">
                  <td className="py-3.5 px-4 flex items-center gap-3">
                    <img src={st.avatar} alt={st.name} className="w-8 h-8 rounded-full object-cover border" referrerPolicy="no-referrer" />
                    <div>
                      <span className="font-bold text-slate-800 block">{st.name}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{st.email}</span>
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="font-medium text-slate-700 block">{st.role}</span>
                    <span className="text-[10px] text-slate-400">{st.specialty}</span>
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="flex flex-wrap gap-1">
                      {st.availability.days.map((d) => (
                        <span key={d} className="text-[9px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
                          {d.substring(0, 3)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="font-mono text-slate-600 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                      {st.availability.hours}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-center">
                    <span className="text-amber-500 font-bold text-xs">★ {st.rating.toFixed(2)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
