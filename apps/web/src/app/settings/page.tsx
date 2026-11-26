import { SettingsView } from "@/components/settings/SettingsView";

export const metadata = { title: "Strategy and Risk · Saarthi" };

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Strategy and Risk</h1>
        <p className="mt-1 text-lg font-medium text-muted">Limits live in code and config. Change them only inside approved ranges, with the PIN; every change is audited.</p>
      </header>
      <SettingsView />
    </main>
  );
}
