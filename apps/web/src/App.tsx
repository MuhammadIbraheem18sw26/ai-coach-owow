import { useEffect, useState } from 'react';
import './App.css';

interface NewExercise {
  week: number;
  question: string;
  answer: string;
}

interface Scenario {
  id: string;
  trustedSessionId: string;
  newExercise: NewExercise;
}

interface UserProfile {
  id: string;
  name: string;
  role: string;
}

interface MemberRecord {
  id: string;
  memberId: string;
  type: 'exercise' | 'commitment' | 'private_chat';
  visibility: 'exercise' | 'private_chat';
  week: number;
  status?: 'completed' | 'active' | 'superseded' | null;
  replacedBy?: string | null;
  senderRole?: 'member' | 'coach' | null;
  question?: string | null;
  text: string;
}

interface MemberWorkspace {
  trustedSessionId: string;
  user: UserProfile;
  storageBackend: string;
  embeddingModel: string;
  exercises: MemberRecord[];
  commitments: MemberRecord[];
  privateChats: MemberRecord[];
}

interface SemanticSearchResult {
  id: string;
  recordType: 'private_chat' | 'exercise' | 'commitment';
  visibility: 'private_chat' | 'exercise';
  week: number;
  status?: string | null;
  senderRole?: string | null;
  text: string;
  similarity: number;
}

interface TraceDecision {
  recordId: string;
  recordType: string;
  week: number;
  decision: 'included' | 'excluded';
  reason: string;
}

interface FeedbackResponse {
  feedback: {
    observation: string;
    reflectionQuestion: string;
    possibleNextCommitment: string;
  };
  trace: {
    trustedSessionId: string;
    resolvedMemberId: string;
    adapterUsed: string;
    storageBackend: string;
    langfuseEnabled?: boolean;
    langfuseTraceId?: string | null;
    decisions: TraceDecision[];
    sanitizedModelInput: unknown;
  };
}

const SENSITIVE_NUMBER_REGEX = /\+?\d[\d\s\-.\(\)]{6,}\d/g;

function maskSensitiveNumbers(text: string): string {
  return text.replace(SENSITIVE_NUMBER_REGEX, (match) => {
    const digitCount = (match.match(/\d/g) || []).length;
    return digitCount >= 8 ? 'X'.repeat(Math.max(16, digitCount)) : match;
  });
}

export default function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('continuity');
  const [trustedSessionId, setTrustedSessionId] = useState<string>('session-101');
  const [week, setWeek] = useState<number>(2);
  const [question, setQuestion] = useState<string>('');
  const [answer, setAnswer] = useState<string>('');
  const [simulateFailure, setSimulateFailure] = useState<boolean>(false);

  const [workspace, setWorkspace] = useState<MemberWorkspace | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackResponse | null>(null);
  const [savedCommitmentMsg, setSavedCommitmentMsg] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState<boolean>(true);

  // Reset DB confirmation modal state
  const [showResetModal, setShowResetModal] = useState<boolean>(false);
  const [resetConfirmText, setResetConfirmText] = useState<string>('');
  const [resetting, setResetting] = useState<boolean>(false);

  // Private Chat & Semantic Vector Search state
  const [privateChatInput, setPrivateChatInput] = useState<string>('');
  const [sendingChat, setSendingChat] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('leaving job or career argument');
  const [searchScope, setSearchScope] = useState<'private_chat' | 'all'>('all');
  const [searchResults, setSearchResults] = useState<SemanticSearchResult[] | null>(null);
  const [searching, setSearching] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/scenarios')
      .then((res) => res.json())
      .then((data) => {
        setScenarios(data.scenarios || []);
        if (data.scenarios?.length > 0) {
          applyScenario(data.scenarios[0]);
        }
      })
      .catch(() =>
        setError(
          'Could not load scenarios from API. Ensure the NestJS backend (:3000) and Python LangGraph AI service (:8000) are running.'
        )
      );
  }, []);

  async function loadWorkspace(sessionId: string) {
    try {
      const res = await fetch(`/api/member-workspace?trustedSessionId=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const data: MemberWorkspace = await res.json();
        setWorkspace(data);
      }
    } catch {
      // ignore background workspace fetch error
    }
  }

  function applyScenario(scenario: Scenario) {
    setSelectedScenarioId(scenario.id);
    setTrustedSessionId(scenario.trustedSessionId);
    setWeek(scenario.newExercise.week);
    setQuestion(scenario.newExercise.question);
    setAnswer(scenario.newExercise.answer);
    setResult(null);
    setError(null);
    setSavedCommitmentMsg(null);
    setSearchResults(null);
    void loadWorkspace(scenario.trustedSessionId);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSavedCommitmentMsg(null);

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trustedSessionId,
          newExercise: { week, question, answer },
          simulateFailure,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
          errBody.message || errBody.detail || `Request failed with status ${res.status}`
        );
      }
      const data: FeedbackResponse = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  async function handleAdoptCommitment() {
    if (!result) return;
    try {
      const res = await fetch('/api/commitments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trustedSessionId,
          week,
          text: result.feedback.possibleNextCommitment,
        }),
      });
      if (!res.ok) throw new Error('Failed to save commitment');
      const saved = await res.json();
      setSavedCommitmentMsg(
        `Saved '${saved.id}' in PostgreSQL commitments table for Week ${week} (previous active commitment marked superseded).`
      );
      void loadWorkspace(trustedSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save commitment');
    }
  }

  async function handleSendPrivateChat(e: React.FormEvent) {
    e.preventDefault();
    if (!privateChatInput.trim()) return;
    setSendingChat(true);
    try {
      const res = await fetch('/api/private-chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trustedSessionId,
          week,
          message: privateChatInput.trim(),
        }),
      });
      if (!res.ok) throw new Error('Failed to send private chat message');
      setPrivateChatInput('');
      await loadWorkspace(trustedSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send private chat');
    } finally {
      setSendingChat(false);
    }
  }

  async function handleVectorSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch('/api/private-chat/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trustedSessionId,
          query: searchQuery.trim(),
          scope: searchScope,
          topK: 5,
        }),
      });
      if (!res.ok) throw new Error('Vector search failed');
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vector search error');
    } finally {
      setSearching(false);
    }
  }

  async function handleResetFixture(e: React.FormEvent) {
    e.preventDefault();
    if (resetConfirmText.trim().toLowerCase() !== 'reset') return;
    setResetting(true);
    try {
      await fetch('/api/reset', { method: 'POST' });
      setSavedCommitmentMsg('PostgreSQL tables & pgvector embeddings reset to original fixture data.');
      setResult(null);
      setSearchResults(null);
      setShowResetModal(false);
      setResetConfirmText('');
      await loadWorkspace(trustedSessionId);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div>
          <h1>The Coach That Remembers</h1>
        </div>
      </header>

      {showResetModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="caution-banner">
              <strong>Caution: Reset All Database &amp; Fixture Data</strong>
            </div>
            <p className="muted">
              This action will wipe any newly added commitments and private chat messages in
              PostgreSQL + <code>pgvector</code> and restore the original trial-day fixture state.
            </p>
            <form onSubmit={handleResetFixture} className="form">
              <label>
                Type <code>reset</code> below to confirm deletion:
                <input
                  autoFocus
                  placeholder="Type reset to confirm"
                  value={resetConfirmText}
                  onChange={(e) => setResetConfirmText(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowResetModal(false);
                    setResetConfirmText('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-danger"
                  disabled={resetConfirmText.trim().toLowerCase() !== 'reset' || resetting}
                >
                  {resetting ? 'Resetting...' : 'Confirm Reset DB'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <section className="scenario-bar">
        <label className="scenario-label">
          <span>Load Member Session / Scenario:</span>
          <select
            className="scenario-select"
            value={selectedScenarioId}
            onChange={(e) => {
              const found = scenarios.find((s) => s.id === e.target.value);
              if (found) applyScenario(found);
            }}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} ({s.trustedSessionId})
              </option>
            ))}
          </select>
        </label>
        {workspace && (
          <span className="user-badge">
            Active User: <strong>{workspace.user.name}</strong> — <em>{workspace.user.role}</em>
          </span>
        )}
        <button
          type="button"
          className="btn-danger-outline btn-end-row"
          onClick={() => {
            setResetConfirmText('');
            setShowResetModal(true);
          }}
        >
          Reset DB &amp; Fixture Data
        </button>
      </section>

      <main className="grid">
        <section className="card">
          <h2>1. Weekly Exercise Submission (Exercise-Visible Flow)</h2>
          <form onSubmit={handleSubmit} className="form">
            <div className="row">
              <label>
                Server Session Fixture (`trustedSessionId`) — Locked
                <input
                  value={trustedSessionId}
                  readOnly
                  disabled
                  className="input-locked"
                  title="Server-selected session fixture (uneditable by client)"
                />
              </label>
              <label>
                Week
                <input
                  type="number"
                  value={week}
                  onChange={(e) => setWeek(Number(e.target.value))}
                />
              </label>
            </div>

            <label>
              Exercise Question
              <input value={question} onChange={(e) => setQuestion(e.target.value)} />
            </label>

            <label>
              Your Reflection / Answer
              <textarea
                rows={3}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={simulateFailure}
                onChange={(e) => setSimulateFailure(e.target.checked)}
              />
              Simulate model service outage (503 fallback test)
            </label>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Generating Coaching Feedback...' : 'Submit Exercise & Get Feedback'}
            </button>
          </form>

          {error && (
            <div className="error-banner" role="alert">
              <strong>Service Notice:</strong> {error}
            </div>
          )}

          {result && (
            <div className="feedback-box">
              <h3>Coach Feedback</h3>
              <div className="feedback-item">
                <span className="badge">Observation</span>
                <p>{result.feedback.observation}</p>
              </div>
              <div className="feedback-item">
                <span className="badge">Reflection Question</span>
                <p>
                  <strong>{result.feedback.reflectionQuestion}</strong>
                </p>
              </div>
              <div className="feedback-item">
                <span className="badge">Possible Next Commitment</span>
                <p>{result.feedback.possibleNextCommitment}</p>
                <button type="button" className="btn-secondary" onClick={handleAdoptCommitment}>
                  Adopt as My Active Commitment
                </button>
              </div>
              {savedCommitmentMsg && <p className="success-msg">{savedCommitmentMsg}</p>}
            </div>
          )}
        </section>

        <section className="card trace-card">
          <div className="trace-header">
            <h2>2. Reviewer Trace &amp; Privacy Boundary Proof</h2>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowTrace(!showTrace)}
            >
              {showTrace ? 'Hide Trace' : 'Show Trace'}
            </button>
          </div>

          {!result && (
            <p className="muted">
              Submit the exercise to inspect deterministic context selection and verify that{' '}
              <code>private_chats</code> and other members&apos; records never enter the model input.
            </p>
          )}

          {result && showTrace && (
            <div className="trace-content">
              <p>
                <strong>Resolved Member:</strong> <code>{result.trace.resolvedMemberId}</code> (via{' '}
                <code>{result.trace.trustedSessionId}</code>) | <strong>Adapter:</strong>{' '}
                <code>{result.trace.adapterUsed}</code> | <strong>Store:</strong>{' '}
                <code>{result.trace.storageBackend}</code> | <strong>Langfuse:</strong>{' '}
                <code>
                  {result.trace.langfuseEnabled
                    ? `Active (${result.trace.langfuseTraceId || 'traced'})`
                    : 'Standby (set LANGFUSE_PUBLIC_KEY)'}
                </code>
              </p>

              <h4>1. Deterministic Record Filtering (Pre-LLM)</h4>
              <table className="trace-table">
                <thead>
                  <tr>
                    <th>Record ID</th>
                    <th>Type (Wk)</th>
                    <th>Decision</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trace.decisions.map((d) => (
                    <tr
                      key={d.recordId}
                      className={d.decision === 'included' ? 'row-inc' : 'row-exc'}
                    >
                      <td>
                        <code>{d.recordId}</code>
                      </td>
                      <td>
                        {d.recordType} (W{d.week})
                      </td>
                      <td>
                        <strong>{d.decision.toUpperCase()}</strong>
                      </td>
                      <td>{d.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4>2. Exact Sanitized Model Input Sent to LLM Adapter</h4>
              <pre className="code-block">
                {JSON.stringify(result.trace.sanitizedModelInput, null, 2)}
              </pre>
            </div>
          )}
        </section>
      </main>

      {workspace && (
        <section className="grid bottom-grid">
          <div className="card">
            <div className="trace-header">
              <h2>3. Confidential 1-on-1 AI Coach Chat (`private_chats` Table)</h2>
              <span className="private-pill">Strictly Private — Isolated from Exercise Flow</span>
            </div>
            <p className="muted">
              Messages here are stored in PostgreSQL <code>private_chats</code> with 1536-d{' '}
              <code>pgvector</code> embeddings for personal recall, and are deterministically blocked
              from entering the Weekly Exercise Feedback prompt.
            </p>

            <div className="chat-thread">
              {workspace.privateChats.length === 0 ? (
                <p className="muted">No private chat messages yet for {workspace.user.id}.</p>
              ) : (
                workspace.privateChats.map((msg) => (
                  <div
                    key={msg.id}
                    className={
                      msg.senderRole === 'coach' ? 'chat-bubble coach-bubble' : 'chat-bubble member-bubble'
                    }
                  >
                    <div className="chat-meta">
                      <code>{msg.id}</code> • <strong>{msg.senderRole || 'member'}</strong> • Week{' '}
                      {msg.week} • <code>visibility={msg.visibility}</code>
                    </div>
                    <p>{maskSensitiveNumbers(msg.text)}</p>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSendPrivateChat} className="chat-form">
              <input
                placeholder="Share a confidential reflection with your private coach..."
                value={privateChatInput}
                onChange={(e) => setPrivateChatInput(e.target.value)}
              />
              <button type="submit" className="btn-primary" disabled={sendingChat}>
                {sendingChat ? 'Sending...' : 'Send Private Message'}
              </button>
            </form>
          </div>

          <div className="card">
            <h2>4. Semantic Vector Search (`pgvector` Cosine Similarity) &amp; Member DB Tables</h2>
            <p className="muted">
              Search across <strong>{workspace.user.id}</strong>&apos;s own embedded records using{' '}
              <code>1 - (embedding &lt;=&gt; query_vec)</code>. Cross-member records (e.g.{' '}
              <code>member-404</code>) are filtered at the SQL query boundary.
            </p>

            <form onSubmit={handleVectorSearch} className="search-bar">
              <input
                placeholder="Search your private chats, exercises, and commitments..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <select
                value={searchScope}
                onChange={(e) => setSearchScope(e.target.value as 'private_chat' | 'all')}
              >
                <option value="all">All My Records (Private Chat + Exercises + Commitments)</option>
                <option value="private_chat">Only My Private Chats</option>
              </select>
              <button type="submit" className="btn-primary" disabled={searching}>
                {searching ? 'Searching...' : 'Vector Search'}
              </button>
            </form>

            {searchResults && (
              <div className="search-results">
                <h4>Top Vector Matches (Scoped to {workspace.user.id})</h4>
                <table className="trace-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Table / Type</th>
                      <th>Similarity</th>
                      <th>Text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <code>{r.id}</code>
                        </td>
                        <td>
                          <code>{r.recordType}</code> (W{r.week})
                        </td>
                        <td>
                          <strong>{r.similarity.toFixed(3)}</strong>
                        </td>
                        <td>{r.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h4>PostgreSQL Member History (`exercises` &amp; `commitments` Tables)</h4>
            <table className="trace-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Table</th>
                  <th>Week / Status</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {workspace.commitments.map((c) => (
                  <tr key={c.id} className={c.status === 'active' ? 'row-inc' : ''}>
                    <td>
                      <code>{c.id}</code>
                    </td>
                    <td>commitments</td>
                    <td>
                      W{c.week} • <strong>{c.status}</strong>
                      {c.replacedBy ? ` (-> ${c.replacedBy})` : ''}
                    </td>
                    <td>{c.text}</td>
                  </tr>
                ))}
                {workspace.exercises.map((ex) => (
                  <tr key={ex.id}>
                    <td>
                      <code>{ex.id}</code>
                    </td>
                    <td>exercises</td>
                    <td>W{ex.week}</td>
                    <td>{ex.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
