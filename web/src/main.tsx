import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { queryClient } from './api/client';
import { ToastProvider } from './ui';
import App from './App';
import './styles.css';

// Mock API: dev server with ?mock (remembered for the tab), or a build made with VITE_MOCK=1. Both are compile-time
// false in a normal production build, so the mock module and its data are dropped from the bundle.
const mock = import.meta.env.VITE_MOCK === '1'
  || (import.meta.env.DEV && (new URLSearchParams(location.search).has('mock') || sessionStorage.getItem('mock') === '1'));

async function boot() {
  if (mock) {
    sessionStorage.setItem('mock', '1');
    await import('./api/mock');
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <App />
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
