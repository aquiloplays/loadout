// TikFinity setup wizard.
//
// Goal: a streamer with no technical chops can connect TikFinity to
// Loadout in under 5 minutes. The page walks them through six steps,
// each one self-contained so they can pause + come back.
//
// Auth: owner-gated for v1 via the /api/admin/tikfinity/* proxies
// (which forward an HMAC envelope to the loadout-discord Worker).
// V2: drop the owner gate; the worker already keys per-user state on
// the forwarded ownerId so the lookup path is already per-user.
//
// Architecture notes:
//   - The personalised webhook URL is bound to a 32+ char random key
//     minted on first visit. "Reset my key" rotates it.
//   - "Waiting for test event..." polls /api/admin/tikfinity/recent
//     every 2 seconds with a 30s timeout, then either resolves to the
//     connected state or surfaces a clear "didn't hear anything" hint.
//   - "Test it" calls /api/admin/tikfinity/test-fire which round-trips
//     a synthetic event through the worker so the user can verify the
//     pipeline without needing a real viewer.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type KeyState = {
  key: string;
  createdAt: number;
  lastEventAt: number | null;
  eventCount: number;
};

type RecentEvent = {
  event: string;
  uniqueId: string;
  nickname?: string;
  ts: number;
  diamondCount?: number;
  repeatCount?: number;
  test?: boolean;
};

type RecentResp = {
  ok: boolean;
  connected: boolean;
  lastEventAt: number | null;
  eventCount: number;
  events: RecentEvent[];
};

type EventToggleKey = 'gift' | 'like' | 'follow' | 'share' | 'member';

const EVENT_TOGGLES: { id: EventToggleKey; label: string; blurb: string }[] = [
  {
    id: 'gift',
    label: 'Gifts',
    blurb: 'When someone sends a gift (roses, sunglasses, lions, etc). The big one - rewards your top gifters.',
  },
  {
    id: 'like',
    label: 'Likes',
    blurb: 'When someone taps the heart button. Lots of these! Best for cumulative goals, not per-event reactions.',
  },
  {
    id: 'follow',
    label: 'Follows',
    blurb: 'When someone follows your TikTok. Great for a small celebration overlay.',
  },
  {
    id: 'share',
    label: 'Shares',
    blurb: 'When someone shares your livestream. Worth a thank-you shoutout.',
  },
  {
    id: 'member',
    label: 'Members joining',
    blurb: 'When a viewer joins your stream. Quieter than likes, perfect for a name-on-screen welcome.',
  },
];

const LOCAL_PREFS_KEY = 'aquilo.tikfinity.event-prefs';

function workerBase(): string {
  return process.env.NEXT_PUBLIC_WORKER_BASE
    || 'https://loadout-discord.aquiloplays.workers.dev';
}

function buildWebhookUrl(key: string): string {
  return `${workerBase()}/tikfinity/event?key=${encodeURIComponent(key || '<your-key>')}`;
}

function fmtAge(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function TikFinitySetupPage() {
  const [keyState, setKeyState] = useState<KeyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [copyTick, setCopyTick] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [recent, setRecent] = useState<RecentResp | null>(null);
  const [waitingForEvent, setWaitingForEvent] = useState(false);
  const [waitOutcome, setWaitOutcome] = useState<'idle' | 'got-it' | 'timeout'>('idle');
  const [eventPrefs, setEventPrefs] = useState<Record<EventToggleKey, boolean>>({
    gift: true, like: true, follow: true, share: false, member: false,
  });

  const baselineEventCount = useRef<number | null>(null);
  const pollAbort = useRef<{ aborted: boolean } | null>(null);

  // Initial fetch: get the key, then prime the recent buffer so the
  // status panel renders something on first paint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/admin/tikfinity/key', { method: 'GET' });
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || !j.ok) {
          setAuthError(j.error || `key fetch failed (${r.status})`);
        } else {
          setKeyState({
            key: j.key,
            createdAt: j.createdAt,
            lastEventAt: j.lastEventAt ?? null,
            eventCount: j.eventCount ?? 0,
          });
        }
      } catch (e) {
        if (!cancelled) setAuthError(e instanceof Error ? e.message : 'network');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Background recent-events poll. Runs once on mount + every 5s so
  // the status panel reflects reality even when the wizard step is
  // not actively waiting.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch('/api/admin/tikfinity/recent', { method: 'GET' });
        if (!r.ok) return;
        const j = (await r.json()) as RecentResp;
        if (!cancelled) setRecent(j);
      } catch { /* network hiccup, retry on next tick */ }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Load saved event prefs from localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCAL_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          setEventPrefs((cur) => ({ ...cur, ...parsed }));
        }
      }
    } catch { /* localStorage may be blocked; ignore */ }
  }, []);

  const webhookUrl = useMemo(() => buildWebhookUrl(keyState?.key || ''), [keyState?.key]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopyTick(true);
      setTimeout(() => setCopyTick(false), 1500);
    } catch {
      // Fallback: select the input text.
      const el = document.getElementById('webhook-url') as HTMLInputElement | null;
      if (el) { el.focus(); el.select(); }
    }
  }, [webhookUrl]);

  const onReset = useCallback(async () => {
    if (!confirm('Rotate your TikFinity key? You will need to paste the new URL into TikFinity again.')) return;
    setResetting(true);
    try {
      const r = await fetch('/api/admin/tikfinity/key', { method: 'DELETE' });
      const j = await r.json();
      if (r.ok && j.ok) {
        setKeyState({
          key: j.key,
          createdAt: j.createdAt,
          lastEventAt: null,
          eventCount: 0,
        });
        setRecent((cur) => cur ? { ...cur, events: [], connected: false, eventCount: 0, lastEventAt: null } : cur);
        setWaitOutcome('idle');
      } else {
        alert('Reset failed: ' + (j.error || r.status));
      }
    } finally {
      setResetting(false);
    }
  }, []);

  const onTestFire = useCallback(async () => {
    setTesting(true);
    try {
      const r = await fetch('/api/admin/tikfinity/test-fire', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        alert('Test send failed: ' + (j.error || r.status));
      }
    } finally {
      setTesting(false);
    }
  }, []);

  const onWaitForTestEvent = useCallback(async () => {
    if (waitingForEvent) return;
    setWaitOutcome('idle');
    setWaitingForEvent(true);
    baselineEventCount.current = recent?.eventCount ?? 0;
    const ac = { aborted: false };
    pollAbort.current = ac;
    const start = Date.now();
    const TIMEOUT_MS = 30_000;
    const POLL_MS = 2000;
    while (!ac.aborted) {
      if (Date.now() - start > TIMEOUT_MS) { setWaitOutcome('timeout'); break; }
      try {
        const r = await fetch('/api/admin/tikfinity/recent', { method: 'GET' });
        if (r.ok) {
          const j = (await r.json()) as RecentResp;
          setRecent(j);
          if (j.eventCount > (baselineEventCount.current ?? 0)) {
            setWaitOutcome('got-it');
            break;
          }
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    setWaitingForEvent(false);
  }, [waitingForEvent, recent?.eventCount]);

  const onCancelWait = useCallback(() => {
    if (pollAbort.current) pollAbort.current.aborted = true;
    setWaitingForEvent(false);
  }, []);

  const onToggleEvent = useCallback((id: EventToggleKey) => {
    setEventPrefs((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      try { localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const connected = !!recent?.connected;

  return (
    <main className="container">
      <header style={{ marginBottom: 20 }}>
        <h1>Connect TikFinity to Loadout</h1>
        <p className="muted">
          Bring your TikTok-Live gifts, likes, follows, and shares into Loadout so they
          power on-stream alerts, leaderboards, and the gifter role. Takes about 5 minutes.
        </p>
      </header>

      <StatusPanel
        connected={connected}
        lastEventAt={recent?.lastEventAt ?? null}
        eventCount={recent?.eventCount ?? 0}
        onTest={onTestFire}
        testing={testing}
        loading={loading}
        authError={authError}
      />

      {!authError && (
        <>
          <StepCard num={1} title="Install TikFinity on your computer">
            <p>
              TikFinity is a free TikTok-Live event bridge. It runs on your machine alongside
              OBS or Streamer.bot and forwards events to Loadout. Grab it here:
            </p>
            <p>
              <a className="btn btn-primary" href="https://tikfinity.zerody.one/" target="_blank" rel="noreferrer noopener">
                Download TikFinity
              </a>
            </p>
            <p className="small muted">Windows only. If you already have it installed, skip ahead.</p>
          </StepCard>

          <StepCard num={2} title="Open Settings, Webhooks in TikFinity">
            <p>
              In TikFinity, click <strong>Settings</strong> in the left sidebar, then choose
              <strong> Webhooks</strong>. You will see a list of webhook actions; click
              <strong> Add Webhook</strong> and pick the event types you want (start with Gift).
            </p>
            <p className="small muted">
              Tip: TikFinity wants one webhook per event type. The URL you paste in step 3 is
              the same for every event, so you can copy it once and reuse it.
            </p>
          </StepCard>

          <StepCard num={3} title="Paste this URL into each TikFinity webhook">
            <p>This is your personalised webhook URL. Keep it private; treat it like a password.</p>
            <div className="url-box">
              <input
                id="webhook-url"
                readOnly
                value={loading ? 'Loading...' : webhookUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button className="btn btn-primary" onClick={onCopy} disabled={!keyState?.key}>
                {copyTick ? 'Copied!' : 'Copy URL'}
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="small muted">
                HTTP method: <code>POST</code>. Content type: <code>application/json</code>.
              </span>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-danger" onClick={onReset} disabled={resetting || !keyState?.key}>
                {resetting ? 'Rotating...' : 'Reset my key'}
              </button>
              <span className="small muted">
                Use this if you accidentally shared the URL, or you want a fresh start.
              </span>
            </div>
          </StepCard>

          <StepCard num={4} title="Click Test in TikFinity">
            <p>
              In TikFinity, on each webhook you just added, click the <strong>Test</strong> button
              once. We will watch for the incoming event right here and confirm it landed.
            </p>
            <div className="row" style={{ marginTop: 8 }}>
              {!waitingForEvent && (
                <button className="btn btn-primary" onClick={onWaitForTestEvent} disabled={!keyState?.key}>
                  Start listening
                </button>
              )}
              {waitingForEvent && (
                <button className="btn btn-ghost" onClick={onCancelWait}>Stop listening</button>
              )}
            </div>
            {waitingForEvent && (
              <div className="notice notice-wait">Waiting for test event... up to 30 seconds.</div>
            )}
            {waitOutcome === 'got-it' && !waitingForEvent && (
              <div className="notice notice-ok">Got it! TikFinity is connected.</div>
            )}
            {waitOutcome === 'timeout' && !waitingForEvent && (
              <div className="notice notice-bad">
                We did not hear anything in 30 seconds. See the FAQ at the bottom of the page for
                what to check (firewall, URL typo, webhook saved).
              </div>
            )}
            {recent && recent.events.length > 0 && (
              <div className="event-list" aria-label="Recent TikFinity events">
                {recent.events.slice(0, 5).map((ev, i) => (
                  <div className="ev" key={i}>
                    <strong>{ev.event}</strong> from {ev.nickname || ev.uniqueId || 'unknown'}
                    {ev.test ? ' (test)' : ''}
                    {ev.diamondCount ? ` - ${ev.diamondCount} diamonds x${ev.repeatCount || 1}` : ''}
                    {' '}({fmtAge(ev.ts)})
                  </div>
                ))}
              </div>
            )}
          </StepCard>

          <StepCard num={5} title="Choose which events to enable">
            <p className="muted small">
              Pick the event types you want Loadout to react to. You can change these anytime;
              the worker will keep accepting every event and these toggles control which ones
              trigger on-stream alerts and counters.
            </p>
            {EVENT_TOGGLES.map((t) => (
              <label className="checkbox-row" key={t.id}>
                <input
                  type="checkbox"
                  checked={eventPrefs[t.id]}
                  onChange={() => onToggleEvent(t.id)}
                />
                <span>
                  <strong>{t.label}</strong>
                  <span className="small muted">{t.blurb}</span>
                </span>
              </label>
            ))}
            <p className="small muted" style={{ marginTop: 10 }}>
              Your selection is saved on this device. We will move this to your account in v2.
            </p>
          </StepCard>

          <StepCard num={6} title="Verify with a real event">
            <p>
              Final check: from another phone (or ask a friend), send a small gift on your
              TikTok live. The status panel up top should flip to <strong>Connected</strong>
              within a couple of seconds. If it does, you are done.
            </p>
            <p className="small muted">
              No second phone handy? Hit the <strong>Test it</strong> button in the status panel
              above. It fires a synthetic event through the exact same pipeline and counts as a
              successful round-trip.
            </p>
          </StepCard>

          <FaqSection />
        </>
      )}
    </main>
  );
}

function StatusPanel(props: {
  connected: boolean;
  lastEventAt: number | null;
  eventCount: number;
  onTest: () => void;
  testing: boolean;
  loading: boolean;
  authError: string | null;
}) {
  const { connected, lastEventAt, eventCount, onTest, testing, loading, authError } = props;
  return (
    <section className="card card-accent" aria-live="polite">
      <div className="row row-spread" style={{ gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>TikFinity status</h2>
          {loading && <p className="small muted" style={{ margin: 0 }}>Checking...</p>}
          {!loading && authError && (
            <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>
              {authError === 'owner-required'
                ? 'This page is owner-only for now. v2 opens it up to any signed-in streamer.'
                : `Sign-in problem: ${authError}`}
            </p>
          )}
          {!loading && !authError && (
            <p className="small muted" style={{ margin: 0 }}>
              {connected
                ? `Last event ${fmtAge(lastEventAt)} - ${eventCount} total`
                : 'No events received yet. Finish the wizard below, then send a test.'}
            </p>
          )}
        </div>
        <div className="row" style={{ flex: '0 0 auto' }}>
          {!loading && !authError && (
            <span className={'pill ' + (connected ? 'pill-ok' : 'pill-wait')}>
              {connected ? 'Connected' : 'Not connected'}
            </span>
          )}
          <button className="btn" onClick={onTest} disabled={testing || loading || !!authError}>
            {testing ? 'Sending...' : 'Test it'}
          </button>
        </div>
      </div>
    </section>
  );
}

function StepCard({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>
        <span className="step-num">{num}</span>
        {title}
      </h2>
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  );
}

function FaqSection() {
  return (
    <section className="card">
      <h2>FAQ and troubleshooting</h2>

      <details className="faq-item">
        <summary>Events are not showing up.</summary>
        <p>
          Check three things, in order. First, make sure the webhook URL in TikFinity matches
          the URL on this page byte-for-byte (no trailing space, the key is correct).
          Second, confirm the webhook is actually enabled in TikFinity - the toggle next to it
          should be on. Third, hit the Test button in TikFinity itself; if that does not fire
          anything, TikFinity is not receiving TikTok events (re-link your TikTok account in
          its Settings, Account tab).
        </p>
      </details>

      <details className="faq-item">
        <summary>TikFinity says it cannot reach the URL.</summary>
        <p>
          Almost always a typo or a stale key. Click <strong>Reset my key</strong> above, copy
          the new URL, and paste it back into TikFinity overwriting the old one. If that does
          not work, your machine may be blocking outbound HTTPS to *.workers.dev - check your
          firewall or antivirus and allow the TikFinity executable through. The endpoint is
          plain HTTPS, no special ports.
        </p>
      </details>

      <details className="faq-item">
        <summary>I get duplicate events.</summary>
        <p>
          This usually means TikFinity has more than one webhook pointed at the same event type.
          Open TikFinity, Settings, Webhooks, and confirm each event (Gift, Like, Follow, Share)
          appears at most once in the list. Loadout de-duplicates within a small window, but
          identical webhooks fired back-to-back will both land.
        </p>
      </details>

      <details className="faq-item">
        <summary>Can I see what events have arrived?</summary>
        <p>
          The recent-events list on step 4 shows the last 10 events in the past 15 minutes. For
          a longer history, head to the Loadout dock and open the Gifter Roles panel; every
          contribution is logged there with timestamps.
        </p>
      </details>

      <details className="faq-item">
        <summary>Is my webhook URL secret?</summary>
        <p>
          Yes. Anyone with the URL can post fake events that count toward your leaderboards.
          Treat it like a password. If you ever paste it somewhere public by accident (a stream
          on-screen, a Discord screenshot, a GitHub issue), click Reset my key and rotate it.
        </p>
      </details>
    </section>
  );
}
