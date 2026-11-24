import { OrdersView } from "@/components/orders/OrdersView";

export const metadata = { title: "Orders · Saarthi" };

export default function OrdersPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Orders</h1>
        <p className="mt-1 text-lg font-medium text-muted">
          Every order walks the same checked path. A position is never left without its stop: if the stop can&apos;t be placed, it is sold at once.
        </p>
      </header>
      <OrdersView />
    </main>
  );
}
