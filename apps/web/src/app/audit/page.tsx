import { Suspense } from "react";
import { AuditView } from "@/components/audit/AuditView";

export const metadata = { title: "Audit · Saarthi" };

export default function AuditPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Audit log</h1>
        <p className="mt-1 text-lg font-medium text-muted">Every signal, rule result, order step, setting change, alert and kill-switch press, hash-chained and append-only.</p>
      </header>
      <Suspense>
        <AuditView />
      </Suspense>
    </main>
  );
}
