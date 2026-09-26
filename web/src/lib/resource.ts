"use client";

// Client-side data loading with a localStorage fallback (degraded mode): the last good payload per key is
// cached, and shown with a "cached" badge when the API fails. Mock mode serves labelled sample data instead.
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./api";
import { useMounted } from "./hooks";
import { useMockMode } from "./mode";

const PREFIX = "2bme:cache:";

interface Cached<T> {
  at: string;
  data: T;
}

export function cacheGet<T>(key: string): Cached<T> | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Cached<T>) : null;
  } catch {
    return null;
  }
}

export function cacheSet<T>(key: string, data: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify({ at: new Date().toISOString(), data }));
  } catch {
    /* quota / private mode */
  }
}

export type ResourceStatus = "loading" | "ok" | "cached" | "sample" | "empty" | "error";

export interface Resource<T> {
  data: T | null;
  status: ResourceStatus;
  error: string | null;
  /** when the cached payload was stored (status "cached") */
  cachedAt: string | null;
  reload: () => void;
}

export function useResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: { sample?: () => T; emptyOn404?: boolean } = {},
): Resource<T> {
  const mock = useMockMode();
  const mounted = useMounted();
  const [state, setState] = useState<Omit<Resource<T>, "reload">>({ data: null, status: "loading", error: null, cachedAt: null });
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  const optsRef = useRef(opts);
  useEffect(() => {
    fetcherRef.current = fetcher;
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!key || !mounted) return;
    if (mock && optsRef.current.sample) {
      setState({ data: optsRef.current.sample(), status: "sample", error: null, cachedAt: null });
      return;
    }
    const ctl = new AbortController();
    setState((s) => ({ ...s, status: s.data ? s.status : "loading" }));
    fetcherRef
      .current(ctl.signal)
      .then((data) => {
        cacheSet(key, data);
        setState({ data, status: "ok", error: null, cachedAt: null });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        if (optsRef.current.emptyOn404 && e instanceof ApiError && e.status === 404) {
          setState({ data: null, status: "empty", error: null, cachedAt: null });
          return;
        }
        const msg = e instanceof ApiError ? (e.offline ? "API offline" : `${e.status}: ${e.detail}`) : String(e);
        const cached = cacheGet<T>(key);
        if (cached) setState({ data: cached.data, status: "cached", error: msg, cachedAt: cached.at });
        else setState({ data: null, status: "error", error: msg, cachedAt: null });
      });
    return () => ctl.abort();
  }, [key, mock, mounted, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
