export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Qwen</h1>
      <p className="max-w-md text-center text-lg text-neutral-500 dark:text-neutral-400">
        Next.js + TypeScript + Tailwind CSS, deployed on Vercel.
      </p>
      <div className="flex gap-4">
        <a
          href="https://nextjs.org/docs"
          className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-80"
        >
          Next.js Docs
        </a>
        <a
          href="https://tailwindcss.com/docs"
          className="rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Tailwind Docs
        </a>
      </div>
    </main>
  );
}
