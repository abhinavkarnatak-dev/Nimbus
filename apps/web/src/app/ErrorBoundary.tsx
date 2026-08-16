import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div className="fallback" role="alert">
        <div className="fallback__inner">
          <p className="fallback__eyebrow">Something broke</p>
          <h1 className="fallback__title">This page stopped working</h1>
          <p className="fallback__body">
            Your session is safe on the server. Reloading picks it back up where it was.
          </p>
          <button
            className="fallback__action"
            type="button"
            onClick={(): void => {
              globalThis.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
