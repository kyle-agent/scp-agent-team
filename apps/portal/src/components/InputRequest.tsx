import { useState } from 'react';
import type { PendingInput } from '@scp/contracts';

/**
 * The human-in-the-loop pause.
 *
 * The agent stopped because it needs an answer. Answering resumes the same
 * kagent task, so everything it had already worked out is still there - this is
 * not a new question to a fresh agent.
 */
export function InputRequest({
  request,
  disabled,
  onAnswer,
}: {
  request: PendingInput;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState('');
  const freeText = request.allow_free_text ?? !request.options?.length;

  return (
    <div className="ask">
      <div className="ask__head">
        <span className="ask__badge">Waiting for you</span>
      </div>
      <p className="ask__prompt">{request.prompt}</p>

      {request.capability && (
        <pre className="ask__capability">{JSON.stringify(request.capability, null, 2)}</pre>
      )}

      {request.options && request.options.length > 0 && (
        <div className="ask__options">
          {request.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="ask__option"
              disabled={disabled}
              onClick={() => onAnswer(option.value)}
            >
              <span className="ask__option-label">
                {option.label}
                {option.risk && option.risk !== 'read-only' && (
                  <span className={`risk risk--${option.risk}`}>{option.risk}</span>
                )}
              </span>
              {option.detail && <span className="ask__option-detail">{option.detail}</span>}
            </button>
          ))}
        </div>
      )}

      {freeText && (
        <form
          className="ask__free"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={request.options?.length ? 'Or answer in your own words…' : 'Your answer…'}
            disabled={disabled}
            autoFocus
          />
          <button type="submit" className="btn btn--primary" disabled={disabled || !text.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
