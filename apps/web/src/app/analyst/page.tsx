import { AnalystView } from "@/components/analyst/AnalystView";

export const metadata = { title: "AI Analyst · Saarthi" };

export default function AnalystPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">AI Analyst</h1>
        <p className="mt-1 text-lg font-medium text-muted">
          The AI picks among code-computed candidates and explains why. Every number it cites is checked against the snapshot.
        </p>
      </header>
      <AnalystView />
    </main>
  );
}
