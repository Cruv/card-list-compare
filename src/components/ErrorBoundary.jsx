import { Component } from 'react';
import './ErrorBoundary.css';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-icon">!</div>
          <h3 className="error-boundary-title">Something went wrong</h3>
          <p className="error-boundary-message">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => this.setState({ hasError: false, error: null })}
            type="button"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
