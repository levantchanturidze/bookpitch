export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-8 py-24 font-sans">
      <div>
        <p className="mb-2 font-mono text-xs tracking-widest text-slate-400 uppercase">
          Bookpitch · P0
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
          Scaffolding complete — modules pending.
        </h1>
      </div>

      <p className="text-sm leading-relaxed text-slate-600">
        Next.js App Router, Tailwind, ESLint and Prettier are wired up. The prototype&apos;s six
        React components have been copied into <code className="font-mono text-xs">components/</code>
        untouched, and its type contract lives in{' '}
        <code className="font-mono text-xs">lib/types.ts</code>. The next task (P1.1) is to
        translate <code className="font-mono text-xs">schema.sql</code> into Prisma, provision
        Postgres, and seed from <code className="font-mono text-xs">lib/seed-data.ts</code>.
      </p>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-[11px] leading-relaxed text-slate-500">
        <p className="mb-2 font-bold tracking-wider text-slate-700 uppercase">Project layout</p>
        <pre className="whitespace-pre-wrap">
          {`app/         Next.js routes (App Router)
components/  Ported prototype UI (not yet mounted)
lib/         Shared TS: types.ts, seed-data.ts (soon: db.ts, auth.ts)
prisma/      DB schema + migrations (added in P1.1)
prototype/   Reference: the original AI Studio prototype`}
        </pre>
      </div>
    </main>
  );
}
