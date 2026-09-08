import React from 'react';
import { textDocumentSessions } from '../utils/textDocumentSessions';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, reloading: false, reloadError: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Caught exception:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload = async () => {
    this.setState({ reloading: true, reloadError: null });
    try {
      // The boundary replaces Canvas, so its persistence hooks are already
      // unmounted by the time this button is pressed. Settle shared text-file
      // drafts here rather than allowing a direct reload to abandon them.
      const result = await textDocumentSessions.flushAndSettleAll();
      if (!result.success) {
        const paths = result.unresolvedFilePaths?.join(', ');
        this.setState({
          reloading: false,
          reloadError: `Reload paused: resolve the unsaved text file${paths ? ` (${paths})` : ''} first.`,
        });
        return;
      }
      window.location.reload();
    } catch (error) {
      this.setState({
        reloading: false,
        reloadError: `Reload paused: ${error?.message || 'could not settle text-file changes'}.`,
      });
    }
  };

  handleReloadWithoutSavingTextDrafts = () => {
    this.setState({ reloading: true, reloadError: null });
    try {
      // This is the explicit escape hatch for a render failure that removed
      // every Reload/Keep mine control. It cancels local debounce/queued work;
      // a write already handed to Electron cannot be recalled.
      textDocumentSessions.abandonAll();
      window.location.reload();
    } catch (error) {
      this.setState({
        reloading: false,
        reloadError: `Could not abandon text-file drafts: ${error?.message || 'unknown error'}.`,
      });
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 text-slate-200 p-8">
          <div className="bg-slate-800 p-8 rounded-lg shadow-xl max-w-2xl border border-red-900/50">
            <h1 className="text-2xl font-bold text-red-500 mb-4 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              Critical Application Error
            </h1>
            
            <p className="mb-6 text-slate-300 border-l-4 border-slate-600 pl-4 py-1">
              Canvas encountered an unexpected rendering error. Your most recent autosave up to this moment has been preserved.
            </p>
            
            <div className="bg-slate-950 p-4 rounded font-mono text-xs overflow-auto max-h-64 mb-6 border border-slate-700 custom-scrollbar opacity-80">
              <div className="text-red-400 mb-2">{this.state.error && this.state.error.toString()}</div>
              <div className="text-slate-500 whitespace-pre-wrap">{this.state.errorInfo && this.state.errorInfo.componentStack}</div>
            </div>

            {this.state.reloadError && (
              <p className="mb-4 text-sm text-amber-300" role="alert">{this.state.reloadError}</p>
            )}
            
            <p className="mb-4 text-xs text-slate-400">
              Reloading without saving cancels pending text-draft writes. A write already sent to the app cannot be recalled.
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={this.handleReloadWithoutSavingTextDrafts}
                disabled={this.state.reloading}
                className="px-4 py-2 border border-red-500/50 text-red-200 hover:bg-red-500/15 rounded font-medium transition-colors"
              >
                Reload Without Saving Text Drafts
              </button>
              <button 
                onClick={this.handleReload}
                disabled={this.state.reloading}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium transition-colors shadow-lg"
              >
                {this.state.reloading ? 'Saving text files…' : 'Reload Application'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
