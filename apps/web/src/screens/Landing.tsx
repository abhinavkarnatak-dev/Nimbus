import { Button } from '../ui/Button.js';
import { ROUTE_PATHS } from '../app/routes.js';
import { navigate } from '../app/useRoute.js';

interface RunStep {
  what: string;
  detail: string;
  mark: string;
}

const RUN_STEPS: readonly RunStep[] = [
  { what: 'Cloned', detail: 'at one immutable commit', mark: 'no token inside' },
  { what: 'Read', detail: 'src/routing/redirect.ts', mark: '4 files' },
  { what: 'Proposed', detail: 'a patch, then had it checked', mark: 'policy passed' },
  { what: 'Ran', detail: 'typecheck, lint, tests', mark: 'all green' },
];

interface Limit {
  word: string;
  what: string;
  why: string;
}

const LIMITS_SHOWN: readonly Limit[] = [
  {
    word: 'never merges',
    what: 'Every change arrives as a pull request.',
    why: 'Nimbus cannot merge, approve, close or force push. You read the diff and decide.',
  },
  {
    word: 'never your branch',
    what: 'It writes only to a branch it created.',
    why: 'Your default branch is not a place Nimbus is able to write to at all.',
  },
  {
    word: 'never your keys',
    what: 'The sandbox holds no credentials.',
    why: 'No token, database URL or provider key ever reaches the machine running the code.',
  },
];

export function Landing(): React.JSX.Element {
  return (
    <div className="container container--wide">
      <section className="hero">
        <div>
          <p className="hero__eyebrow">Cloud coding agent</p>

          <h1 className="hero__title">
            Describe the change.
            <br />
            <em>Review the pull request.</em>
          </h1>

          <p className="hero__lede">
            Nimbus takes one small task on one repository, works in an isolated sandbox, checks its
            own patch, and opens a pull request for you to review. It changes nothing else.
          </p>

          <div className="hero__actions">
            <Button
              tone="primary"
              large
              onClick={(): void => {
                navigate(ROUTE_PATHS.sign_in);
              }}
            >
              Sign in to start
            </Button>

            <a className="button button--secondary button--large" href="#limits">
              What it will not do
            </a>
          </div>

          <p className="hero__meta">One public repository, one task at a time, no card required.</p>
        </div>

        <div className="hero-run" aria-label="What a finished session looks like">
          <div className="hero-run__bar">
            <span className="hero-run__dot" aria-hidden="true" />
            <span className="hero-run__repo">shopfront / main</span>
          </div>

          <p className="hero-run__task">
            &ldquo;The login redirect always sends people to the dashboard.&rdquo;
          </p>
          <ol className="hero-run__steps">
            {RUN_STEPS.map((step, at) => (
              <li
                className="hero-run__step"
                key={step.what}
                style={{ '--step-index': at } as React.CSSProperties}
              >
                <span className="hero-run__index">{String(at + 1).padStart(2, '0')}</span>
                <span className="hero-run__what">
                  <strong>{step.what}</strong> {step.detail}
                </span>
                <span className="hero-run__mark">{step.mark}</span>
              </li>
            ))}
          </ol>

          <div className="hero-run__out">
            <span>
              <strong>Pull request opened</strong> for review
            </span>
            <span className="hero-run__badge">awaiting you</span>
          </div>
        </div>
      </section>

      <section className="limits" id="limits">
        <h2 className="limits__title">What Nimbus is not allowed to do</h2>

        <ul className="limits__list">
          {LIMITS_SHOWN.map((limit) => (
            <li className="limits__item" key={limit.word}>
              <span className="limits__word">{limit.word}</span>
              <p className="limits__what">{limit.what}</p>
              <p className="limits__why">{limit.why}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
