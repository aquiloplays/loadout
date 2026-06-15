// aquilo-site landing page placeholder. The full marketing surface
// lives at aquilo-gg/ for now; this is here so /tikfinity-setup is
// reachable through the same Next.js app.

export default function Home() {
  return (
    <main className="container">
      <h1>Aquilo</h1>
      <p className="muted">Streaming tools for creators.</p>
      <p>
        <a className="btn btn-primary" href="/tikfinity-setup">TikFinity setup wizard</a>
      </p>
    </main>
  );
}
