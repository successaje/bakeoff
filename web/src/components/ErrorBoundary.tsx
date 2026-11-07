/**
 * What a visitor sees when part of a page fails to render: the error, and a
 * way to try again, in place of the part that failed. Without a boundary
 * React clears the whole page, which leaves only the background.
 */

import { Component, type ReactNode } from "react";
import { useRouteError } from "react-router";

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="panel-empty error-notice" role="alert">
      <p><strong>Something went wrong showing this.</strong></p>
      <p className="mono small break">{message(error)}</p>
      <div className="row">
        {onRetry && <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => location.reload()}>Reload the page</button>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  error: unknown;
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(error);
  }

  render() {
    if (this.state.failed) {
      return <ErrorNotice error={this.state.error} onRetry={() => this.setState({ error: null, failed: false })} />;
    }
    return this.props.children;
  }
}

/** A page's error, shown inside the site's header and footer. */
export function PageError() {
  const error = useRouteError();
  return (
    <section className="section">
      <div className="container">
        <ErrorNotice error={error} />
      </div>
    </section>
  );
}
