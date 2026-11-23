import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Params = Record<string, string | number | boolean | null | undefined>;

export function qs(params?: Params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init?.method || 'GET',
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** GET a contract path. The key is the path + params so writes can invalidate by path prefix. */
export function useApi<T>(path: string | null, params?: Params) {
  return useQuery<T, ApiError>({
    queryKey: [path, params || {}],
    queryFn: () => api<T>(path! + qs(params)),
    enabled: path !== null,
  });
}

/** A write that refreshes every cached read afterwards (cheap: a household's data is small). */
export function useWrite<B = unknown, R = unknown>(method: string, path: string | ((b: B) => string)) {
  const qc = useQueryClient();
  return useMutation<R, ApiError, B>({
    mutationFn: b => api<R>(typeof path === 'function' ? path(b) : path, { method, body: b ?? {} }),
    onSuccess: () => qc.invalidateQueries(),
  });
}
