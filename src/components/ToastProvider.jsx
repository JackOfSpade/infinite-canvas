import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

const ToastIcon = ({ type }) => {
  switch (type) {
    case 'success':
      return <CheckCircle2 className="text-emerald-400" size={18} />;
    case 'error':
      return <AlertCircle className="text-red-400" size={18} />;
    case 'info':
    default:
      return <Info className="text-blue-400" size={18} />;
  }
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback(({ title, description, type = 'info', duration = 4000 }) => {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    setToasts((prev) => {
      const next = [...prev, { id, title, description, type, duration }];
      // Cap at 5 toasts — discard oldest if over limit
      return next.length > 5 ? next.slice(next.length - 5) : next;
    });
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      
      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-[10001] flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onRemove }) {
  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => {
        onRemove(toast.id);
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast, onRemove]);

  return (
    <div className="bg-black/80 backdrop-blur-md border border-white/10 shadow-lg rounded-lg p-3 flex items-start gap-3 w-80 pointer-events-auto animate-in slide-in-from-right-4 fade-in duration-300">
      <div className="mt-0.5">
        <ToastIcon type={toast.type} />
      </div>
      <div className="flex-1">
        <div className="text-white text-sm font-semibold">{toast.title}</div>
        {toast.description && (
          <div className="text-white/60 text-xs mt-0.5">{toast.description}</div>
        )}
      </div>
      <button 
        onClick={() => onRemove(toast.id)}
        className="text-white/40 hover:text-white transition-colors p-1 -mr-1 -mt-1"
      >
        <X size={14} />
      </button>
    </div>
  );
}
