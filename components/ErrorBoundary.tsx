'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  onError?: (error: Error) => void;
}

// Last-resort guard around the browser-only call view.
export class ErrorBoundary extends React.Component<Props, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Call view crashed:', error, info);
    this.props.onError?.(error);
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}
