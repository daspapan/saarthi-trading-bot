import { OrdersView } from "@/components/orders/OrdersView";
import { Term } from "@/components/Term";

export const metadata = { title: "Orders · Saarthi" };

export default function OrdersPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Orders</h1>
        <p className="mt-1 text-lg font-medium text-muted">
          Every order walks the same checked path. A position is never left without its <Term t="stop-loss">stop</Term> and target (an <Term t="OCO">OCO</Term>): if they can&apos;t be placed, it is sold at once.
        </p>
      </header>
      <OrdersView />
    </main>
  );
}
