import { useEffect, useState } from "react";

/** The value once it has stopped changing for ms: a check on every keystroke would flash errors on half-typed text. */
export function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
