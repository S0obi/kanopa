import { useEffect, useState } from "react";

/** The value once it has stopped changing for ms: a read on every keystroke or arrow key would be wasted. */
export function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
