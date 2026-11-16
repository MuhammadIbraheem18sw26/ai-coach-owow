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
    decisions: TraceDecision[];
    sanitizedModelInput: unknown;
  };
}

export default function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('continuity');
  const [trustedSessionId, setTrustedSessionId] = useState<string>('session-101');
  const [week, setWeek] = useState<number>(2);
  const [question, setQuestion] = useState<string>('');
  const [answer, setAnswer] = useState<string>('');
  const [simulateFailure, setSimulateFailure] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackResponse | null>(null);
  const [savedCommitmentMsg, setSavedCommitmentMsg] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState<boolean>(true);

  useEffect(() => {
    fetch('/api/scenarios')
      .then((res) => res.json())
      .then((data) => {
        setScenarios(data.scenarios || []);
        if (data.scenarios?.length > 0) {
          applyScenario(data.scenarios[0]);
        }
      })
      .catch(() => setError('Could not load scenarios from API. Is the FastAPI backend running on :8000?'));
  }, []);

  function applyScenario(scenario: Scenario) {
    setSelectedScenarioId(scenario.id);
    setTrustedSessionId(scenario.trustedSessionId);
    setWeek(scenario.newExercise.week);
    setQuestion(scenario.newExercise.question);
    setAnswer(scenario.newExercise.answer);
    setResult(null);
    setError(null);
    setSavedCommitmentMsg(null);
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
        throw new Error(errBody.detail || `Request failed with status ${res.status}`);
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
        `Saved '${saved.id}' as your active commitment for Week ${week} (any previous active commitment is now marked superseded).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save commitment');
    }
  }

  async function handleResetFixture() {
    await fetch('/api/reset', { method: 'POST' });
    setSavedCommitmentMsg('Fixture state reset to original PDF records.');
    setResult(null);
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div>
          <h1>The Coach That Remembers</h1>
          <p className="subtitle">Leadership Programme — Weekly Exercise & Grounded AI Feedback</p>
        </div>
        <button type="button" className="btn-secondary" onClick={handleResetFixture}>
          Reset Fixture Data
        </button>
      </header>

      <section className="scenario-bar">
        <span>Load Fixture Scenario:</span>
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            className={selectedScenarioId === s.id ? 'chip active' : 'chip'}
            onClick={() => applyScenario(s)}
          >
            {s.id} ({s.trustedSessionId})
          </button>
        ))}
      </section>

      <main className="grid">
        <section className="card">
          <h2>Weekly Exercise Submission</h2>
          <form onSubmit={handleSubmit} className="form">
            <div className="row">
              <label>
                Server Session Fixture (`trustedSessionId`)
                <input value={trustedSessionId} readOnly />
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
                rows={4}
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
                <p><strong>{result.feedback.reflectionQuestion}</strong></p>
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
            <h2>Reviewer Trace & Privacy Boundary Proof</h2>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowTrace(!showTrace)}
            >
              {showTrace ? 'Hide Trace' : 'Show Trace'}
            </button>
          </div>

          {!result && <p className="muted">Submit the exercise to inspect context selection and model input.</p>}

          {result && showTrace && (
            <div className="trace-content">
              <p>
                <strong>Resolved Member:</strong> <code>{result.trace.resolvedMemberId}</code> (via{' '}
                <code>{result.trace.trustedSessionId}</code>) | <strong>Adapter:</strong>{' '}
                <code>{result.trace.adapterUsed}</code>
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
                    <tr key={d.recordId} className={d.decision === 'included' ? 'row-inc' : 'row-exc'}>
                      <td><code>{d.recordId}</code></td>
                      <td>{d.recordType} (W{d.week})</td>
                      <td><strong>{d.decision.toUpperCase()}</strong></td>
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
    </div>
  );
}
