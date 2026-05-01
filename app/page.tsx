import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-semibold">管理员面板</h1>
        <p className="text-slate-400">此部署仅用于管理授权与内置服务。</p>
        <Link
          href="/admin"
          className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
        >
          进入 /admin
        </Link>
      </div>
    </main>
  );
}
